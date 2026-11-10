import { T, type ToolDef } from "@floppy/core";
import type { GraphAuth } from "./graph.ts";
import { plain } from "./util.ts";
import { Scan, dataText, dateText, daysPeriod, limit, matches, periodFields, safeHandler, scopeText } from "./query.ts";

export function channelReadTool(g: GraphAuth, deps: {
  authorize: () => Promise<void>;
  me: () => Promise<string>;
  resolve: (team: string, channel: string) => Promise<{ team: any; ch: any }>;
}): ToolDef {
  return {
    name: "m365_channel_messages",
    description: "Cherche les publications ET réponses d'un canal Teams par période, author, contains (texte), mentions_me, with_link ou with_attachment. Une réponse récente dans un ancien fil compte aussi. team (équipe) obligatoire, channel (canal) Général par défaut ; days : derniers N jours. Pas d'état non lu garanti pour les canaux. Rend les ids pour répondre au fil. Lecture soumise à la permission Microsoft des canaux.",
    inputSchema: { type: "object", properties: { ...periodFields, team: { type: "string" }, channel: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 90 }, author: { type: "string", description: "Nom complet ou id ; filtre textuel sur l'auteur, sans identité devinée." }, contains: { type: "string" }, mentions_me: { type: "boolean" }, with_link: { type: "boolean" }, with_attachment: { type: "boolean" }, max: { type: "integer", minimum: 1, maximum: 30 } }, required: ["team"] }, level: "read",
    handler: safeHandler(async (a) => {
      const p = daysPeriod(a, 7), scan = new Scan();
      await deps.authorize();
      const me = await deps.me(), { team, ch } = await deps.resolve(String(a.team ?? ""), String(a.channel ?? ""));
      const base = `teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(ch.id)}/messages`;
      const roots = await scan.pages(g, `${base}?$top=50&$expand=replies`);
      const ok = (m: any) => m.messageType === "message" && !m.deletedDateTime;
      const mentioned = (m: any) => (m.mentions ?? []).some((x: any) => x.mentioned?.user?.id === me);
      const body = (m: any) => plain(String(m.body?.content ?? ""), 2000);
      const match = (m: any) => {
        const at = Date.parse(m.createdDateTime);
        return ok(m) && at >= +p.start && at < +p.end && matches(`${m.from?.user?.displayName ?? ""} ${m.from?.user?.id ?? ""}`, a.author)
          && matches(`${m.subject ?? ""} ${body(m)} ${(m.attachments ?? []).map((f: any) => f.name).join(" ")}`, a.contains)
          && (typeof a.mentions_me !== "boolean" || mentioned(m) === a.mentions_me)
          && (typeof a.with_link !== "boolean" || /https?:\/\//i.test(String(m.body?.content ?? "")) === a.with_link)
          && (typeof a.with_attachment !== "boolean" || Boolean(m.attachments?.length) === a.with_attachment);
      };
      const found: { root: any; replies: any[]; rootMatches: boolean }[] = [];
      for (const root of roots.filter(ok)) {
        const replies = [...(root.replies ?? [])];
        if (root["replies@odata.nextLink"]) replies.push(...await scan.pages(g, root["replies@odata.nextLink"]));
        const matching = replies.filter(match).sort((x, y) => Date.parse(x.createdDateTime) - Date.parse(y.createdDateTime));
        const rootMatches = match(root);
        if (rootMatches || matching.length) found.push({ root, replies: matching, rootMatches });
      }
      const activity = (x: typeof found[number]) => Math.max(x.rootMatches ? Date.parse(x.root.createdDateTime) : 0, ...x.replies.map((m) => Date.parse(m.createdDateTime)));
      found.sort((x, y) => activity(y) - activity(x));
      const shown = found.slice(0, limit(a.max, 10, 30)).reverse();
      const render = (lang: string) => {
        const fr = lang === "fr";
        const message = (m: any) => `${dateText(new Date(m.createdDateTime), lang)} — ${m.from?.user?.id === me ? (fr ? "moi" : "me") : m.from?.user?.displayName ?? "?"} : ${m.subject ? `[${m.subject}] ` : ""}« ${body(m)} »${mentioned(m) ? (fr ? " (te mentionne)" : " (mentions you)") : ""} [message id ${m.id}]`;
        return `${fr ? "Canal" : "Channel"} « ${ch.displayName} » ${fr ? "de l'équipe" : "in team"} « ${team.displayName} » [${fr ? "équipe" : "team"} id ${team.id}, ${fr ? "canal" : "channel"} id ${ch.id}]\n${scopeText(p, lang)}\n${scan.note(lang)}\n${shown.length}/${found.length}${scan.partial ? "+" : ""} ${fr ? "fil(s) affiché(s)" : "thread(s) shown"}.\n${shown.map((x) => `- ${message(x.root)}${x.rootMatches ? "" : (fr ? " (contexte du fil ; ne correspond pas aux filtres)" : " (thread context; does not match filters)")}\n${x.replies.slice(-10).map((m) => `    ↳ ${message(m)}`).join("\n")}${x.replies.length > 10 ? `\n${fr ? "Réponses affichées" : "Replies shown"} : 10/${x.replies.length}` : ""}`).join("\n")}\n${dataText(lang)}`;
      };
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  };
}
