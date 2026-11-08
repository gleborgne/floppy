import { T, type ToolDef } from "@floppy/core";
import type { GraphAuth } from "./graph.ts";
import { Scan, boundary, dataText, dateText, daysPeriod, invalid, limit, matches, period, periodFields, safeHandler, scopeText, type Period } from "./query.ts";

const fields = {
  ...periodFields,
  jours: { type: "integer", minimum: 1, maximum: 90, description: "Nombre de jours depuis aujourd'hui ; ne pas combiner avec une période précise. Défaut 1 pour agenda, 14 pour prochain rendez-vous." },
  participant: { type: "string", description: "Nom ou adresse parmi les participants et l'organisateur." },
  organisateur: { type: "string" }, sujet: { type: "string" }, lieu: { type: "string" },
  max: { type: "integer", minimum: 1, maximum: 50 },
};
const personText = (p: any) => `${p?.emailAddress?.name ?? ""} ${p?.emailAddress?.address ?? ""}`.trim();
// Les requêtes imposent UTC aux heures renvoyées par Graph.
const instant = (v: any) => new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(v?.dateTime ?? "") ? v.dateTime : `${v?.dateTime}Z`);

export function calendarTools(g: GraphAuth, max: number): ToolDef[] {
  const range = (a: Record<string, unknown>, days: number, next = false): Period => {
    // Compatibilité : date + jours était la signature historique de l'agenda.
    if (a.date !== undefined && a.jours !== undefined) {
      const start = boundary(a.date);
      if (!start.day) return invalid("date doit désigner un jour.", "date must specify a day.");
      const end = new Date(start.date); end.setDate(end.getDate() + limit(a.jours, days, 90));
      if (a.debut !== undefined || a.fin !== undefined || a.periode !== undefined || a.depuis !== undefined) period(a);
      return { start: start.date, end };
    }
    const p = daysPeriod(a, days, true);
    if (next && !period(a)) p.start = new Date();
    return p;
  };
  const load = async (p: Period, scan: Scan) => (await scan.pages(g,
    `me/calendarView?startDateTime=${encodeURIComponent(p.start.toISOString())}&endDateTime=${encodeURIComponent(p.end.toISOString())}&$top=50&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,isCancelled,isAllDay,showAs,responseStatus,webLink`,
  )).filter((e) => !e.isCancelled).sort((a, b) => +instant(a.start) - +instant(b.start));
  const filter = (e: any, a: Record<string, unknown>) => matches(e.subject, a.sujet) && matches(e.location?.displayName, a.lieu)
    && matches(personText(e.organizer), a.organisateur)
    && matches([e.organizer, ...(e.attendees ?? [])].map(personText).join(" "), a.participant);
  const line = (e: any, lang: string) => `${e.subject || (lang === "fr" ? "(sans titre)" : "(no title)")} — ${dateText(instant(e.start), lang)} → ${dateText(instant(e.end), lang)}${e.isAllDay ? (lang === "fr" ? " (journée entière)" : " (all day)") : ""}\n${lang === "fr" ? "Organisateur" : "Organizer"} : ${personText(e.organizer)} ; ${lang === "fr" ? "participants" : "attendees"} : ${(e.attendees ?? []).map(personText).join(", ") || "?"}${e.location?.displayName ? ` ; ${e.location.displayName}` : ""} ; ${e.showAs ?? "?"} ; ${e.responseStatus?.response ?? "?"}\n[id ${e.id}]${e.onlineMeeting?.joinUrl ? ` [${lang === "fr" ? "rejoindre" : "join"} ${e.onlineMeeting.joinUrl}]` : ""}${e.webLink ? ` [${e.webLink}]` : ""}`;
  const make = (next: boolean): ToolDef => ({
    name: next ? "m365_prochain_rdv" : "m365_agenda",
    description: next ? "Prochain rendez-vous Outlook correspondant aux critères (participant, sujet, lieu, période). Défaut : à partir de maintenant sur 14 jours. Exemple : prochaine réunion avec Sophie sur le budget. Rend id, participants et lien. Une réunion déjà commencée est écartée." : "Agenda Outlook filtrable par période, participant, organisateur, sujet et lieu. Défaut aujourd'hui. Exemples : demain après-midi ; réunions avec Sophie cette semaine. Inclut occurrences récurrentes et événements qui chevauchent la période. Rend id, participants et lien pour les questions suivantes.",
    inputSchema: { type: "object", properties: fields }, level: "read",
    handler: safeHandler(async (a) => {
      const p = range(a, next ? 14 : 1, next), scan = new Scan();
      const all = (await load(p, scan)).filter((e) => filter(e, a) && (!next || +instant(e.start) >= +p.start));
      const shown = all.slice(0, next ? 1 : limit(a.max, max));
      const render = (lang: string) => `${lang === "fr" ? "Agenda : rendez-vous correspondants" : "Calendar: matching events"} (${shown.length}/${all.length}${scan.partial ? "+" : ""}).\n${scopeText(p, lang)}\n${scan.note(lang)}\n${shown.map((e, i) => `${i + 1}. ${line(e, lang)}`).join("\n")}\n${dataText(lang)}`;
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  });
  return [make(false), make(true), {
    name: "m365_creneaux_libres",
    description: "Cherche des créneaux libres dans le seul agenda de l'utilisateur. Durée, période locale, plage horaire quotidienne et marge entre réunions. Défaut : 30 minutes, 7 jours à partir d'aujourd'hui, lundi-vendredi 09:00–18:00. N'indique pas la disponibilité des collègues. Refuse de garantir un créneau si le parcours de l'agenda est incomplet.",
    inputSchema: { type: "object", properties: { ...periodFields, duree_min: { type: "integer", minimum: 5, maximum: 480 }, marge_min: { type: "integer", minimum: 0, maximum: 120 }, heure_debut: { type: "string", description: "HH:MM local, défaut 09:00." }, heure_fin: { type: "string", description: "HH:MM local, défaut 18:00." }, weekend: { type: "boolean", description: "Inclure samedi et dimanche, défaut false." }, max: { type: "integer", minimum: 1, maximum: 25 } } }, level: "read",
    handler: safeHandler(async (a) => {
      const duration = Number(a.duree_min ?? 30), margin = Number(a.marge_min ?? 0);
      if (!Number.isInteger(duration) || duration < 5 || duration > 480 || !Number.isInteger(margin) || margin < 0 || margin > 120) return invalid("Durée ou marge invalide.", "Invalid duration or buffer.");
      const clock = (v: unknown) => {
        const m = /^(\d{2}):(\d{2})$/.exec(String(v));
        if (!m || +m[1]! > 23 || +m[2]! > 59) return invalid("Heure invalide : utilise HH:MM.", "Invalid time: use HH:MM.");
        return +m[1]! * 60 + +m[2]!;
      };
      const lo = clock(a.heure_debut ?? "09:00"), hi = clock(a.heure_fin ?? "18:00");
      if (lo >= hi) return invalid("La plage horaire doit finir après son début.", "The daily time window must end after it starts.");
      const p = period(a) ?? daysPeriod({}, 7, true), scan = new Scan();
      if (+p.end - +p.start > 91 * 864e5) return invalid("Limite la recherche de créneaux à 90 jours.", "Limit free-slot searches to 90 days.");
      const events = await load(p, scan);
      if (scan.partial) return { status: "unverified", text: T("Agenda incomplet : impossible de garantir les créneaux libres.", "Incomplete calendar: free slots cannot be guaranteed.") };
      const busy = events.filter((e) => e.showAs !== "free" && e.responseStatus?.response !== "declined").map((e) => ({ start: +instant(e.start) - margin * 60000, end: +instant(e.end) + margin * 60000 })).sort((x, y) => x.start - y.start);
      const slots: Period[] = [], day = new Date(p.start); day.setHours(0, 0, 0, 0);
      for (; day < p.end; day.setDate(day.getDate() + 1)) {
        if (!a.weekend && [0, 6].includes(day.getDay())) continue;
        const begin = new Date(day), finish = new Date(day); begin.setMinutes(lo); finish.setMinutes(hi);
        let cursor = Math.max(+begin, +p.start, Date.now());
        const end = Math.min(+finish, +p.end);
        for (const b of busy) {
          if (b.end <= cursor || b.start >= end) continue;
          if (b.start - cursor >= duration * 60000) slots.push({ start: new Date(cursor), end: new Date(b.start) });
          cursor = Math.max(cursor, b.end);
        }
        if (end - cursor >= duration * 60000) slots.push({ start: new Date(cursor), end: new Date(end) });
      }
      const shown = slots.slice(0, limit(a.max, 5, 25));
      const render = (lang: string) => `${lang === "fr" ? "Créneaux libres dans ton agenda" : "Free slots in your calendar"} (${shown.length}/${slots.length}, ≥ ${duration} min ; ${lang === "fr" ? "marge" : "buffer"} ${margin} min).\n${scopeText(p, lang)}\n${shown.map((s, i) => `${i + 1}. ${dateText(s.start, lang)} → ${dateText(s.end, lang)}`).join("\n")}`;
      return { status: "done", text: T(render("fr"), render("en")) };
    }),
  }];
}
