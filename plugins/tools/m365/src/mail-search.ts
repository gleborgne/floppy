import { T, type ToolDef } from "@floppy/core";
import type { GraphAuth } from "./graph.ts";
import { plain } from "./util.ts";
import { Scan, choice, dataText, dateText, invalid, limit, matches, period, periodFields, safeHandler, scopeText } from "./query.ts";

const fields = {
  ...periodFields,
  requete: { type: "string", description: "Mots à rechercher dans expéditeur, sujet et corps. Facultatif si d'autres filtres sont donnés." },
  expediteur: { type: "string", description: "Nom complet ou adresse de l'expéditeur ; ne pas transformer un prénom en adresse devinée." },
  destinataire: { type: "string", description: "Nom ou adresse parmi À et Cc." },
  sujet: { type: "string", description: "Mots dans l'objet." },
  contient: { type: "string", description: "Mots dans le texte du mail." },
  lecture: { type: "string", enum: ["tous", "lus", "non_lus"] },
  avec_piece_jointe: { type: "boolean" },
  dossier: { type: "string", enum: ["tous", "reception", "envoyes", "archives", "brouillons"], description: "Défaut tous. La période porte sur l'envoi pour envoyes, la réception sinon." },
  tri: { type: "string", enum: ["recent", "ancien"], description: "Défaut recent. max limite l'affichage après filtrage." },
  max: { type: "integer", minimum: 1, maximum: 50 },
};
const address = (v: any) => `${v?.emailAddress?.name ?? ""} ${v?.emailAddress?.address ?? ""}`;
const label = (v: any) => v?.emailAddress?.name || v?.emailAddress?.address || "?";

export function mailSearchTools(g: GraphAuth, max: number): ToolDef[] {
  const select = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,isRead,hasAttachments,conversationId,webLink";
  return [{
    name: "m365_chercher_mails",
    description: "Cherche des mails Outlook en combinant personne, période, sujet, texte, lecture et pièces jointes. Exemples : mails de Sophie hier sur le budget ; dernier mail envoyé à Contoso. Aucun mot-clé obligatoire. Les noms sont des filtres textuels, pas une identité résolue. Résultats numérotés avec id pour lire le mail ou son fil. Si recherche partielle, ne pas affirmer un total exhaustif ni l'absence de mail.",
    inputSchema: { type: "object", properties: fields }, level: "read",
    handler: safeHandler(async (a) => {
      const p = period(a), scan = new Scan();
      const folder = choice(a, "dossier", ["tous", "reception", "envoyes", "archives", "brouillons"], "tous");
      const read = choice(a, "lecture", ["tous", "lus", "non_lus"], "tous");
      const sort = choice(a, "tri", ["recent", "ancien"], "recent");
      const by = folder === "envoyes" ? "sentDateTime" : "receivedDateTime";
      const filters = [`${by} ge ${p ? p.start.toISOString() : "0001-01-01T00:00:00Z"}`];
      if (p) filters.push(`${by} lt ${p.end.toISOString()}`);
      if (read !== "tous") filters.push(`isRead eq ${read === "lus"}`);
      if (typeof a.avec_piece_jointe === "boolean") filters.push(`hasAttachments eq ${a.avec_piece_jointe}`);
      const folders: Record<string, string> = { reception: "inbox", envoyes: "sentitems", archives: "archive", brouillons: "drafts" };
      const path = folder === "tous" ? "me/messages" : `me/mailFolders/${folders[folder]}/messages`;
      // Sans période, garder la recherche indexée : parcourir seulement les mails récents raterait
      // facilement un ancien échange. Un mot sûr présélectionne les candidats ; tous les critères
      // sont ensuite revérifiés. Graph interdit de combiner $search avec $filter/$orderby.
      let indexed = "";
      if (!p) for (const [key, field] of [["sujet", "subject"], ["contient", "body"], ["requete", ""], ["expediteur", "from"], ["destinataire", "recipients"]]) {
        const word = String(a[key!] ?? "").match(/[\p{L}\p{N}]+/gu)?.find((w) => w.length >= 3 && !/^(AND|OR|NOT)$/i.test(w));
        if (word) { indexed = field ? `${field}:${word}` : word; break; }
      }
      const query = indexed ? `$search=${encodeURIComponent(`"${indexed}"`)}&$top=100` : `$filter=${encodeURIComponent(filters.join(" and "))}&$orderby=${by} ${sort === "ancien" ? "asc" : "desc"}&$top=50`;
      const all = await scan.pages(g, `${path}?${query}&$select=${select}`);
      if (indexed && all.length >= 1000) scan.partial = true; // plafond du moteur de recherche Outlook
      const found = all.filter((m) => (read === "tous" || m.isRead === (read === "lus"))
        && (typeof a.avec_piece_jointe !== "boolean" || m.hasAttachments === a.avec_piece_jointe)
        && matches(address(m.from), a.expediteur)
        && matches([...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(address).join(" "), a.destinataire)
        && matches(m.subject, a.sujet) && matches(plain(String(m.body?.content ?? ""), 1000000), a.contient)
        && matches(`${address(m.from)} ${m.subject} ${plain(String(m.body?.content ?? ""), 1000000)}`, a.requete));
      found.sort((x, y) => (Date.parse(x[by]) - Date.parse(y[by])) * (sort === "ancien" ? 1 : -1));
      const shown = found.slice(0, limit(a.max, max));
      const render = (lang: string) => {
        const fr = lang === "fr";
        const head = fr ? `${found.length} mail(s) trouvé(s)${scan.partial ? " dans la partie consultée" : ""}, ${shown.length} affiché(s). Dossier : ${folder}.` : `${found.length} email(s) found${scan.partial ? " in the scanned portion" : ""}, ${shown.length} shown. Folder: ${folder}.`;
        return `${head}\n${scopeText(p, lang)}\n${scan.note(lang)}\n${shown.map((m, i) => `${i + 1}. ${label(m.from)} → ${(m.toRecipients ?? []).map(label).join(", ")} — ${m.subject || (fr ? "(sans objet)" : "(no subject)")} — ${dateText(new Date(m[by]), lang)}${m.hasAttachments ? (fr ? " — pièce jointe" : " — attachment") : ""} — « ${plain(String(m.bodyPreview ?? m.body?.content ?? ""), 250)} » [id ${m.id}] [conversation ${m.conversationId}]`).join("\n")}\n${dataText(lang)}`;
      };
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  }, {
    name: "m365_lire_fil_mail",
    description: "Lit les échanges reçus et envoyés du fil auquel appartient un mail. Pour « qu'est-ce que je lui avais répondu ? », « résume nos échanges ». id : id du mail déjà trouvé. Chaque mail conserve auteur, date et id. Ne déduis pas une absence de réponse si le parcours est partiel.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, max: { type: "integer", minimum: 1, maximum: 50 } }, required: ["id"] }, level: "read",
    handler: safeHandler(async (a) => {
      const root = await g.get<any>(`me/messages/${encodeURIComponent(String(a.id ?? ""))}?$select=conversationId`);
      if (!root.conversationId) return invalid("Ce mail ne fournit pas d'identifiant de fil.", "This email has no conversation identifier.");
      const scan = new Scan();
      const filter = `conversationId eq '${String(root.conversationId).replace(/'/g, "''")}'`;
      const messages = await scan.pages(g, `me/messages?$filter=${encodeURIComponent(filter)}&$top=50&$select=${select}`);
      messages.sort((x, y) => Date.parse(x.sentDateTime) - Date.parse(y.sentDateTime));
      const shown = messages.slice(-limit(a.max, 20));
      const render = (lang: string) => `${lang === "fr" ? "Fil de mails, du plus ancien au plus récent ; derniers messages affichés" : "Email thread, oldest first; showing latest messages"} (${shown.length}/${messages.length}).\n${scan.note(lang)}\n${shown.map((m) => `${label(m.from)} → ${(m.toRecipients ?? []).map(label).join(", ")} — ${dateText(new Date(m.sentDateTime), lang)} — ${m.subject} [id ${m.id}]\n${plain(String(m.body?.content ?? m.bodyPreview ?? ""), 2500)}`).join("\n\n")}\n${dataText(lang)}`;
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  }];
}
