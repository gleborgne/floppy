import { T, type ToolDef } from "@floppy/core";
import type { GraphAuth } from "./graph.ts";
import { plain } from "./util.ts";
import { Scan, choice, dataText, dateText, invalid, limit, matches, period, periodFields, safeHandler, scopeText } from "./query.ts";

const fields = {
  ...periodFields,
  query: { type: "string", description: "Mots à rechercher dans expéditeur, sujet et corps. Facultatif si d'autres filtres sont donnés." },
  sender: { type: "string", description: "Nom complet ou adresse de l'expéditeur ; ne pas transformer un prénom en adresse devinée." },
  recipient: { type: "string", description: "Nom ou adresse parmi À et Cc." },
  subject: { type: "string", description: "Mots dans l'objet." },
  contains: { type: "string", description: "Mots dans le texte du mail." },
  read_state: { type: "string", enum: ["all", "read", "unread"] },
  with_attachment: { type: "boolean" },
  folder: { type: "string", enum: ["all", "inbox", "sent", "archive", "drafts"], description: "Défaut all. La période porte sur l'envoi pour sent, la réception sinon." },
  sort: { type: "string", enum: ["recent", "oldest"], description: "Défaut recent (oldest : les plus anciens d'abord). max limite l'affichage après filtrage." },
  max: { type: "integer", minimum: 1, maximum: 50 },
};
const address = (v: any) => `${v?.emailAddress?.name ?? ""} ${v?.emailAddress?.address ?? ""}`;
const label = (v: any) => v?.emailAddress?.name || v?.emailAddress?.address || "?";

export function mailSearchTools(g: GraphAuth, max: number): ToolDef[] {
  const select = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,isRead,hasAttachments,conversationId,webLink";
  return [{
    name: "m365_search_mail",
    description: "Cherche des mails Outlook en combinant sender, recipient, période, subject, contains (texte), read_state (all/read/unread) et with_attachment ; query : mots libres. Exemples : mails de Sophie hier sur le budget ; dernier mail envoyé à Contoso. Aucun mot-clé obligatoire. Les noms sont des filtres textuels, pas une identité résolue. Résultats numérotés avec id pour lire le mail ou son fil. Si recherche partielle, ne pas affirmer un total exhaustif ni l'absence de mail.",
    inputSchema: { type: "object", properties: fields }, level: "read",
    handler: safeHandler(async (a) => {
      const p = period(a), scan = new Scan();
      const folder = choice(a, "folder", ["all", "inbox", "sent", "archive", "drafts"], "all");
      const read = choice(a, "read_state", ["all", "read", "unread"], "all");
      const sort = choice(a, "sort", ["recent", "oldest"], "recent");
      const by = folder === "sent" ? "sentDateTime" : "receivedDateTime";
      const filters = [`${by} ge ${p ? p.start.toISOString() : "0001-01-01T00:00:00Z"}`];
      if (p) filters.push(`${by} lt ${p.end.toISOString()}`);
      if (read !== "all") filters.push(`isRead eq ${read === "read"}`);
      if (typeof a.with_attachment === "boolean") filters.push(`hasAttachments eq ${a.with_attachment}`);
      const folders: Record<string, string> = { inbox: "inbox", sent: "sentitems", archive: "archive", drafts: "drafts" };
      const path = folder === "all" ? "me/messages" : `me/mailFolders/${folders[folder]}/messages`;
      // Sans période, garder la recherche indexée : parcourir seulement les mails récents raterait
      // facilement un ancien échange. Un mot sûr présélectionne les candidats ; tous les critères
      // sont ensuite revérifiés. Graph interdit de combiner $search avec $filter/$orderby.
      let indexed = "";
      if (!p) for (const [key, field] of [["subject", "subject"], ["contains", "body"], ["query", ""], ["sender", "from"], ["recipient", "recipients"]]) {
        const word = String(a[key!] ?? "").match(/[\p{L}\p{N}]+/gu)?.find((w) => w.length >= 3 && !/^(AND|OR|NOT)$/i.test(w));
        if (word) { indexed = field ? `${field}:${word}` : word; break; }
      }
      const query = indexed ? `$search=${encodeURIComponent(`"${indexed}"`)}&$top=100` : `$filter=${encodeURIComponent(filters.join(" and "))}&$orderby=${by} ${sort === "oldest" ? "asc" : "desc"}&$top=50`;
      const all = await scan.pages(g, `${path}?${query}&$select=${select}`);
      if (indexed && all.length >= 1000) scan.partial = true; // plafond du moteur de recherche Outlook
      const found = all.filter((m) => (read === "all" || m.isRead === (read === "read"))
        && (typeof a.with_attachment !== "boolean" || m.hasAttachments === a.with_attachment)
        && matches(address(m.from), a.sender)
        && matches([...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(address).join(" "), a.recipient)
        && matches(m.subject, a.subject) && matches(plain(String(m.body?.content ?? ""), 1000000), a.contains)
        && matches(`${address(m.from)} ${m.subject} ${plain(String(m.body?.content ?? ""), 1000000)}`, a.query));
      found.sort((x, y) => (Date.parse(x[by]) - Date.parse(y[by])) * (sort === "oldest" ? 1 : -1));
      const shown = found.slice(0, limit(a.max, max));
      const render = (lang: string) => {
        const fr = lang === "fr";
        const head = fr ? `${found.length} mail(s) trouvé(s)${scan.partial ? " dans la partie consultée" : ""}, ${shown.length} affiché(s). Dossier : ${folder}.` : `${found.length} email(s) found${scan.partial ? " in the scanned portion" : ""}, ${shown.length} shown. Folder: ${folder}.`;
        return `${head}\n${scopeText(p, lang)}\n${scan.note(lang)}\n${shown.map((m, i) => `${i + 1}. ${label(m.from)} → ${(m.toRecipients ?? []).map(label).join(", ")} — ${m.subject || (fr ? "(sans objet)" : "(no subject)")} — ${dateText(new Date(m[by]), lang)}${m.hasAttachments ? (fr ? " — pièce jointe" : " — attachment") : ""} — « ${plain(String(m.bodyPreview ?? m.body?.content ?? ""), 250)} » [id ${m.id}] [conversation ${m.conversationId}]`).join("\n")}\n${dataText(lang)}`;
      };
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  }, {
    name: "m365_read_mail_thread",
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
