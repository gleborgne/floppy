// Calculs de dates et de durées, en heure locale. Entrées : AAAA-MM-JJ ou AAAA-MM-JJTHH:MM (ou « now » / « today »).
// Les jours entre deux dates sans heure se comptent par le calendrier (pas d'effet de l'heure d'été).

export class DateError extends Error {
  readonly fr: string;
  readonly en: string;
  constructor(fr: string, en: string) { super(fr); this.fr = fr; this.en = en; }
}

export const UNITS = ["minutes", "hours", "days", "weeks", "months", "years"] as const;
export type Unit = (typeof UNITS)[number];

export const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
export const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Parsed { date: Date; hasTime: boolean }

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

export function parseWhen(raw: unknown, now: Date, name = "date"): Parsed {
  const s = String(raw ?? "").trim();
  if (!s) throw new DateError(`${name} manquante.`, `${name} is missing.`);
  const low = s.toLowerCase();
  if (low === "now") return { date: new Date(now), hasTime: true };
  if (low === "today") return { date: new Date(now.getFullYear(), now.getMonth(), now.getDate()), hasTime: false };
  const m = RE.exec(s);
  if (!m) throw new DateError(`${name} « ${s.slice(0, 40)} » illisible : écris AAAA-MM-JJ ou AAAA-MM-JJTHH:MM.`, `${name} “${s.slice(0, 40)}” is not readable: write YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0"].map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) {
    throw new DateError(`${name} « ${s} » n'existe pas.`, `${name} “${s}” does not exist.`);
  }
  return { date, hasTime: m[4] !== undefined };
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function iso(d: Date, withTime: boolean): string {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** Nombre de jours calendaires entre deux dates (heure ignorée), `b - a`. */
export function calendarDays(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

/** Ajoute `amount` (entier, négatif = passé) ; mois et années restent dans le mois (31 janv. + 1 mois = 28/29 févr.). */
export function addDuration(d: Date, amount: number, unit: Unit): Date {
  const r = new Date(d);
  switch (unit) {
    case "minutes": return new Date(r.getTime() + amount * 60_000);
    case "hours": return new Date(r.getTime() + amount * 3_600_000);
    case "days": r.setDate(r.getDate() + amount); return r;
    case "weeks": r.setDate(r.getDate() + amount * 7); return r;
    case "months": case "years": {
      const months = unit === "years" ? amount * 12 : amount;
      const day = r.getDate();
      r.setDate(1);
      r.setMonth(r.getMonth() + months);
      const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
      r.setDate(Math.min(day, last));
      return r;
    }
  }
}

/** Jours ouvrés (lundi à vendredi, sans jours fériés), les deux bornes comprises ; négatif si `to` < `from`. */
export function workdaysBetween(from: Date, to: Date): number {
  const sign = calendarDays(from, to) < 0 ? -1 : 1;
  const [a, b] = sign === 1 ? [from, to] : [to, from];
  const total = calendarDays(a, b) + 1;
  const weeks = Math.floor(total / 7);
  let count = weeks * 5;
  const cur = new Date(a.getFullYear(), a.getMonth(), a.getDate() + weeks * 7);
  for (let i = 0; i < total - weeks * 7; i++) {
    const wd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + i).getDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return sign * count;
}
