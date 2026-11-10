import { T, type Text, type ToolDef } from "@floppy/core";
import type { GraphAuth } from "./graph.ts";
import { norm, plain } from "./util.ts";
import { Scan, choice, dataText, dateText, daysPeriod, invalid, limit, matches, periodFields, safeHandler, scopeText, type Period } from "./query.ts";

const fields = {
  ...periodFields,
  days: { type: "integer", minimum: 1, maximum: 90, description: "Compatibilité : derniers N jours ; ne pas combiner avec une période précise. Défaut 14." },
  person: { type: "string", description: "Nom complet, adresse ou id d'un participant. Un prénom ambigu demande une précision." },
  conversation: { type: "string", description: "Id ou nom du groupe. En cas d'ambiguïté, demander lequel." },
  chat_type: { type: "string", enum: ["all", "private", "group"] },
  direction: { type: "string", enum: ["both", "received", "sent"], description: "received : messages des autres ; sent : mes messages ; both par défaut. Avec person, received ne conserve que ses messages." },
  only_them: { type: "boolean", description: "Ancien alias de direction=received avec person." },
  contains: { type: "string", description: "Tous ces mots dans le texte ou les noms de pièces jointes, accents ignorés." },
  with_link: { type: "boolean" }, with_attachment: { type: "boolean" }, mentions_me: { type: "boolean" },
  max: { type: "integer", minimum: 1, maximum: 50, description: "Limite d'affichage après filtrage ; pas une limite de recherche." },
};
const others = (c: any, me: string) => (c.members ?? []).filter((m: any) => m.userId !== me);
export function chatLabel(c: any, me: string, lang: string): string {
  const people = others(c, me), fr = lang === "fr";
  if (c.chatType === "oneOnOne") return fr ? `Discussion privée avec ${people[0]?.displayName ?? "?"}` : `Private chat with ${people[0]?.displayName ?? "?"}`;
  const names = people.slice(0, 4).map((m: any) => String(m.displayName ?? "?").split(" ")[0]).join(", ");
  return c.topic ? (fr ? `Groupe « ${c.topic} » (${names})` : `Group “${c.topic}” (${names})`) : (fr ? `Groupe avec ${names}` : `Group with ${names}`);
}

const lastAt = (c: any) => Date.parse(c.lastMessagePreview?.createdDateTime ?? "");

/** since : les conversations arrivent de la plus récente à la plus ancienne ; on s'arrête dès qu'une page
 *  contient une conversation sans message depuis cette date (les pages suivantes sont plus anciennes). */
export async function loadChatPages(g: GraphAuth, scan: Scan, since?: number): Promise<any[]> {
  const stop = since === undefined ? undefined : (page: any[]) => page.some((c) => lastAt(c) < since);
  try {
    return await scan.pages(g, "me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50", stop);
  } catch (e) {
    // Certains comptes refusent cette expansion. Les erreurs réseau et de droits restent des échecs.
    if (!(e instanceof Error) || !e.message.includes("Microsoft Graph 400")) throw e;
    return scan.pages(g, "me/chats?$expand=members&$top=50");
  }
}

export function teamsReadTools(g: GraphAuth, max: number, labels: Map<string, Text>): ToolDef[] {
  const loadChats = async (scan: Scan, me: string, since?: number) => {
    const all = await loadChatPages(g, scan, since);
    for (const c of all) {
      labels.set(c.id, T(chatLabel(c, me, "fr"), chatLabel(c, me, "en")));
      for (const m of others(c, me)) if (m.email) labels.set(norm(m.email), m.displayName);
    }
    return all;
  };
  const chooseChats = (all: any[], me: string, a: Record<string, unknown>) => {
    let selected = all, pid: string | undefined;
    if (a.person) {
      const people = new Map<string, any>();
      for (const c of all) for (const m of others(c, me)) if (m.userId === a.person || matches(`${m.displayName} ${m.email ?? ""}`, a.person)) people.set(m.userId, m);
      const exact = [...people.values()].filter((m) => m.userId === a.person || [m.displayName, m.email].some((v) => v && norm(v) === norm(a.person)));
      const candidates = exact.length ? exact : [...people.values()];
      if (candidates.length > 1) {
        const names = candidates.map((m) => `${m.displayName}${m.email ? ` (${m.email})` : ""}`).join(", ");
        return invalid(`Plusieurs personnes correspondent : ${names}. Laquelle ?`, `Several people match: ${names}. Which one?`);
      }
      if (!candidates.length) return { selected: [], pid: undefined };
      pid = candidates[0].userId;
      selected = selected.filter((c) => c.members?.some((m: any) => m.userId === pid));
    }
    if (a.conversation) {
      const exact = selected.filter((c) => c.id === a.conversation || norm(c.topic) === norm(a.conversation));
      selected = exact.length ? exact : selected.filter((c) => matches(chatLabel(c, me, "fr"), a.conversation));
      if (selected.length > 1) return invalid(`Plusieurs conversations correspondent : ${selected.map((c) => `${chatLabel(c, me, "fr")} [id ${c.id}]`).join(", ")}. Laquelle ?`, `Several chats match: ${selected.map((c) => `${chatLabel(c, me, "en")} [id ${c.id}]`).join(", ")}. Which one?`);
    }
    const type = choice(a, "chat_type", ["all", "private", "group"], "all");
    if (type !== "all") selected = selected.filter((c) => type === "private" ? c.chatType === "oneOnOne" : c.chatType === "group");
    return { selected, pid };
  };
  const text = (m: any, lang: string) => {
    const files = (m.attachments ?? []).map((f: any) => f.name).filter(Boolean);
    return plain(String(m.body?.content ?? ""), 1200) + (files.length ? ` (${lang === "fr" ? "pièce jointe" : "attachment"} : ${files.join(", ")})` : "");
  };
  const mention = (m: any, me: string) => (m.mentions ?? []).some((x: any) => x.mentioned?.user?.id === me);
  const line = (m: any, me: string, lang: string) => `- ${dateText(new Date(m.createdDateTime), lang)} — ${m.from?.user?.id === me ? (lang === "fr" ? "moi" : "me") : m.from?.user?.displayName ?? m.from?.application?.displayName ?? "?"} : « ${text(m, lang)} »${mention(m, me) ? (lang === "fr" ? " (te mentionne)" : " (mentions you)") : ""} [message id ${m.id ?? "?"}]`;
  const isUnread = (c: any, m: any, me: string) => !c.viewpoint?.isHidden && m.from?.user?.id !== me && Date.parse(m.createdDateTime) > Date.parse(c.viewpoint?.lastMessageReadDateTime ?? "");
  const make = (kind: "list" | "search" | "unread" | "read"): ToolDef => ({
    name: { list: "m365_teams_chats", search: "m365_teams_messages", unread: "m365_teams_unread", read: "m365_read_teams_chat" }[kind],
    description: {
      list: "Liste les conversations Teams privées et de groupe, filtrables par person ou conversation. Rend id, dernier message et état de lecture si connu. Pour chercher le contenu ou une période, utilise m365_teams_messages.",
      search: "Cherche des messages Teams par période, person, conversation (groupe), chat_type (all/private/group), direction, contains (texte), with_link, with_attachment ou mentions_me. Tous les critères se combinent. Exemple : messages reçus de Sophie hier sur le budget ; liens partagés dans Projet Voix cette semaine. Personne facultative. Les résultats portent sur les discussions privées et de groupe, pas les canaux. N'affirme pas un total exhaustif si recherche partielle.",
      unread: "Messages Teams actuellement non lus dans les discussions privées et de groupe, filtrables par période de création, personne, groupe et mentions (mentions_me). État de lecture inconnu signalé. Ne comprend pas les canaux ; pour eux utiliser m365_channel_messages et mentions_me.",
      read: "Lit une conversation Teams dont l'id vient d'un résultat précédent. Période, direction et contains (mots-clés) facultatifs. Rend les messages dans l'ordre avec auteur, date et id, pour résumer puis préciser la recherche.",
    }[kind],
    inputSchema: { type: "object", properties: kind === "list" ? { person: fields.person, conversation: fields.conversation, chat_type: fields.chat_type, max: fields.max } : { ...fields, ...(kind === "read" ? { id: { type: "string", description: "Id de la conversation déjà trouvée." } } : {}) }, ...(kind === "read" ? { required: ["id"] } : {}) },
    level: "read",
    handler: safeHandler(async (a) => {
      const p = daysPeriod(a, kind === "read" ? 30 : kind === "unread" ? 90 : 14), scan = new Scan();
      const sens = choice(a, "direction", ["both", "received", "sent"], a.only_them ? "received" : "both");
      if (a.only_them && a.direction !== undefined && a.direction !== "received") return invalid("only_them contredit direction.", "only_them conflicts with direction.");
      const me = (await g.get<{ id: string }>("me?$select=id")).id;
      // Une conversation nommée (person, conversation) peut être ancienne : inventaire complet. Sinon on s'arrête à la période.
      const since = kind === "list" || a.person || a.conversation ? undefined : +p.start;
      const all = kind === "read" ? [await g.get<any>(`chats/${encodeURIComponent(String(a.id))}?$expand=members`)] : await loadChats(scan, me, since);
      const { selected, pid } = chooseChats(all, me, a);
      if (kind === "list") {
        const shown = selected.slice(0, limit(a.max, max));
        const render = (lang: string) => `${shown.map((c, i) => {
          const m = c.lastMessagePreview, read = c.viewpoint?.lastMessageReadDateTime;
          const state = read ? (m && isUnread(c, m, me) ? (lang === "fr" ? " (non lu)" : " (unread)") : "") : (lang === "fr" ? " (lecture inconnue)" : " (read status unknown)");
          return `${i + 1}. ${chatLabel(c, me, lang)}${state}${m?.body?.content ? ` — ${m.from?.user?.displayName ?? "?"} : « ${plain(m.body.content, 160)} »` : ""} [id ${c.id}]`;
        }).join("\n")}\n${scan.note(lang)}\n${dataText(lang)}`;
        return { status: "done", text: T(render("fr"), render("en")) };
      }
      let missingRead = 0;
      const searched = selected.filter((c) => {
        if (c.lastMessagePreview && lastAt(c) < +p.start) return false; // rien dans la période
        if (kind !== "unread") return true;
        if (!c.viewpoint?.lastMessageReadDateTime) { missingRead++; return false; }
        if (c.viewpoint.isHidden) return false;
        // Dernier message connu et déjà lu : rien de non lu, inutile de lire la conversation.
        return !c.lastMessagePreview || !(lastAt(c) <= Date.parse(c.viewpoint.lastMessageReadDateTime));
      });
      if (searched.length > 10) scan.partial = true;
      const read = await Promise.all(searched.slice(0, 10).map(async (c) => {
        labels.set(c.id, T(chatLabel(c, me, "fr"), chatLabel(c, me, "en")));
        const start = kind === "unread" ? Math.max(+p.start, Date.parse(c.viewpoint.lastMessageReadDateTime) + 1) : +p.start;
        const messages = await scan.pages(g, `chats/${encodeURIComponent(c.id)}/messages?$top=50&$orderby=createdDateTime desc`, (page) => page.some((m: any) => Date.parse(m.createdDateTime) < start));
        return { c, start, messages };
      }));
      const rows: { c: any; m: any }[] = [];
      for (const { c, start, messages } of read) {
        for (const m of messages) {
          const at = Date.parse(m.createdDateTime), author = m.from?.user?.id;
          if (m.messageType !== "message" || m.deletedDateTime || at < start || at >= +p.end) continue;
          if (kind === "unread" && !isUnread(c, m, me)) continue;
          if (sens === "sent" && author !== me || sens === "received" && (author === me || pid && author !== pid)) continue;
          if (!matches(text(m, "fr"), a.contains)) continue;
          if (typeof a.with_attachment === "boolean" && Boolean(m.attachments?.length) !== a.with_attachment) continue;
          const link = /https?:\/\//i.test(String(m.body?.content ?? ""));
          if (typeof a.with_link === "boolean" && link !== a.with_link) continue;
          if (typeof a.mentions_me === "boolean" && mention(m, me) !== a.mentions_me) continue;
          rows.push({ c, m });
        }
      }
      rows.sort((x, y) => Date.parse(y.m.createdDateTime) - Date.parse(x.m.createdDateTime));
      const shown = rows.slice(0, limit(a.max, kind === "unread" ? 10 : 20));
      const render = (lang: string) => {
        const fr = lang === "fr", ids = new Set(shown.map((x) => x.c.id));
        const head = kind === "unread" ? `${new Set(rows.map((x) => x.c.id)).size} ${fr ? "conversation(s) avec des messages non lus" : "chat(s) with unread messages"}` : fr ? "Messages Teams" : "Teams messages";
        const unknown = missingRead ? (fr ? `\nÉtat de lecture inconnu pour ${missingRead} conversation(s) : impossible de garantir l'absence de non-lus.` : `\nRead status unknown for ${missingRead} chat(s): absence of unread messages cannot be guaranteed.`) : "";
        const empty = !rows.length ? (fr ? "\nAucun message trouvé dans le périmètre consulté." : "\nNo messages found within the scanned scope.") : "";
        return `${head} (${shown.length}/${rows.length}${scan.partial ? "+" : ""}).${empty}${unknown}\n${scopeText(p, lang)}\n${scan.note(lang)}\n${[...ids].map((id) => {
          const entries = shown.filter((x) => x.c.id === id).reverse(), c = entries[0]!.c;
          return `${chatLabel(c, me, lang)}${kind === "unread" ? ` — ${rows.filter((x) => x.c.id === id).length}${scan.partial ? "+" : ""} ${fr ? "non lu(s)" : "unread"}` : ""} [id ${id}] :\n${entries.map((x) => line(x.m, me, lang)).join("\n")}`;
        }).join("\n\n")}\n${dataText(lang)}`;
      };
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  });
  return [make("list"), make("search"), make("unread"), make("read")];
}
