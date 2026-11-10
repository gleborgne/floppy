// Rubriques du point du matin (contrat `brief`) : l'agenda du jour et les mails non lus.
// Lecture seule. Le contenu des mails est une donnée : le point le dit au modèle qui l'écrit.
import { T, TextError } from "@floppy/core";
import type { BriefRequest, BriefSection } from "@floppy/contracts";
import { NotConnected, type GraphAuth } from "./graph.ts";

/** Les requêtes imposent UTC aux heures renvoyées par Graph. */
const instant = (v: { dateTime?: string } | undefined) => new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(v?.dateTime ?? "") ? v!.dateTime! : `${v?.dateTime}Z`);
const LOCALE = { fr: "fr-FR", en: "en-GB" } as const;
const hhmm = (d: Date, lang: "fr" | "en") => d.toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit" });
const who = (f?: { emailAddress?: { name?: string; address?: string } }) => f?.emailAddress?.name || f?.emailAddress?.address || "?";
/** Une réunion qui commence dans moins de cette durée rend la rubrique urgente. */
const SOON_MS = 60 * 60_000;

export const BRIEF_ITEMS = [
  { id: "calendar", label: T("Microsoft 365 · agenda du jour", "Microsoft 365 · today's calendar") },
  { id: "mail", label: T("Microsoft 365 · mails non lus", "Microsoft 365 · unread emails") },
];

async function guarded<V>(g: GraphAuth, run: () => Promise<V>): Promise<V> {
  if (!g.connected) throw new TextError(T("Microsoft 365 n'est pas connecté", "Microsoft 365 is not signed in"));
  try { return await run(); } catch (e) {
    if (e instanceof NotConnected) throw new TextError(T("Microsoft 365 n'est pas connecté", "Microsoft 365 is not signed in"));
    throw e;
  }
}

/** Rendez-vous du jour, de maintenant à minuit (ceux déjà finis ne servent plus). */
export async function calendarSection(g: GraphAuth, req: BriefRequest): Promise<BriefSection> {
  const { lang, now } = req;
  const en = lang === "en";
  const end = new Date(now); end.setHours(24, 0, 0, 0);
  const r = await guarded(g, () => g.get<{ value: any[] }>(
    `me/calendarView?startDateTime=${encodeURIComponent(now.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}&$top=50&$orderby=start/dateTime&$select=subject,start,end,location,isCancelled,isAllDay,showAs,responseStatus,onlineMeeting`,
    {}, req.signal,
  ));
  const events = r.value.filter((e) => !e.isCancelled && e.responseStatus?.response !== "declined" && +instant(e.end) > +now)
    .sort((a, b) => +instant(a.start) - +instant(b.start));
  const title = en ? "Today's calendar" : "Agenda du jour";
  if (!events.length) return { title, markdown: en ? "No more meetings today." : "Plus aucun rendez-vous aujourd'hui.", empty: true };
  const lines = events.map((e) => {
    const s = instant(e.start);
    const time = e.isAllDay ? (en ? "all day" : "toute la journée") : `${hhmm(s, lang)}–${hhmm(instant(e.end), lang)}`;
    const where = e.location?.displayName ? ` (${e.location.displayName})` : e.onlineMeeting?.joinUrl ? (en ? " (online)" : " (en ligne)") : "";
    const now_ = !e.isAllDay && +s <= +now ? (en ? " — in progress" : " — en cours") : "";
    return `- ${time}${en ? ": " : " : "}${e.subject || (en ? "(no title)" : "(sans titre)")}${where}${now_}`;
  });
  const soon = events.some((e) => !e.isAllDay && +instant(e.start) - +now < SOON_MS);
  return { title, markdown: lines.join("\n"), urgent: soon };
}

/** Mails non lus reçus depuis le dernier point (au plus 3 jours ; sans dernier point : 24 h). */
export async function mailSection(g: GraphAuth, req: BriefRequest): Promise<BriefSection> {
  const { lang, now } = req;
  const en = lang === "en";
  const floor = +now - 3 * 86_400_000;
  const from = new Date(req.since && +req.since > floor ? +req.since : +now - 86_400_000);
  const filter = `receivedDateTime ge ${from.toISOString()} and isRead eq false`;
  const r = await guarded(g, () => g.get<{ value: any[]; "@odata.count"?: number }>(
    `me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc&$count=true&$top=10&$select=subject,from,receivedDateTime,importance,bodyPreview`,
    {}, req.signal,
  ));
  const title = en ? "Unread emails" : "Mails non lus";
  const count = r["@odata.count"] ?? r.value.length;
  if (!count) return { title, markdown: en ? "No new unread email." : "Aucun nouveau mail non lu.", empty: true };
  const lines = r.value.map((m) => {
    const high = m.importance === "high" ? " [important]" : "";
    const quote = (x: string) => (en ? `“${x}”` : `« ${x} »`);
    const preview = m.bodyPreview ? ` — ${quote(String(m.bodyPreview).replace(/\s+/g, " ").slice(0, 120))}` : "";
    return `- ${who(m.from)}${en ? ": " : " : "}${m.subject || (en ? "(no subject)" : "(sans objet)")}${high}${preview}`;
  });
  const more = count > r.value.length ? `\n${en ? `…and ${count - r.value.length} more.` : `…et ${count - r.value.length} autres.`}` : "";
  const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(from)) / 86_400_000);
  const dm = from.toLocaleDateString(LOCALE[lang], { day: "2-digit", month: "2-digit" });
  const day = diff === 0 ? (en ? "today" : "aujourd'hui") : diff === 1 ? (en ? "yesterday" : "hier") : (en ? `on ${dm}` : `le ${dm}`);
  const head = en
    ? `${count} unread email${count > 1 ? "s" : ""} since ${day} ${hhmm(from, lang)}:`
    : `${count} mail${count > 1 ? "s" : ""} non lu${count > 1 ? "s" : ""} depuis ${day} ${hhmm(from, lang)} :`;
  return { title, markdown: `${head}\n${lines.join("\n")}${more}`, urgent: r.value.some((m) => m.importance === "high") };
}
