// Recherche dans l'historique (outil `search_history`) : filtres de date et de rôle, message voisin, mise en forme bornée.
// La table `history` (FTS5) n'est pas modifiée : le `rowid` implicite donne l'ordre d'enregistrement, donc les voisins.
import type { DatabaseSync } from "node:sqlite";
import { T, type Text } from "@floppy/core";

export interface HistoryRow { rowid: number; t: string; role: string; text: string; session: string }
export interface HistoryQuery {
  /** Mots-clés libres. Vides : on rend les derniers échanges de la période. */
  query: string;
  /** AAAA-MM-JJ local, inclus. */
  since?: string;
  /** AAAA-MM-JJ local, inclus. */
  until?: string;
  role?: "user" | "assistant";
  limit: number;
}
/** Un échange : la demande de l'utilisateur et/ou la réponse de l'assistant qui l'accompagne. */
export interface Exchange { t: string; user?: HistoryRow; assistant?: HistoryRow; matched: ("user" | "assistant")[] }

const HIT_MAX = 600;
const NEIGHBOUR_MAX = 300;
const TOTAL_MAX = 6000;
/** Les voisins se cherchent parmi les lignes enregistrées juste autour (les sessions peuvent s'entrelacer). */
const NEIGHBOUR_WINDOW = 50;

export const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minuit local d'un jour AAAA-MM-JJ, en ISO UTC (comparable au champ `t`). undefined si la date n'existe pas. */
export function dayStartIso(day: string, plusDays = 0): string | undefined {
  const m = DAY.exec(day.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return new Date(y, mo - 1, d + plusDays).toISOString();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const pad = (n: number) => String(n).padStart(2, "0");
/** Date et heure locales lisibles : « 2026-11-06 14:32 ». */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 16) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Requête FTS5 sûre : chaque mot entre guillemets, reliés par OR. */
export function ftsQuery(q: string): string | undefined {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"`).join(" OR ") : undefined;
}

/** Cherche, puis range les résultats en échanges, du plus ancien au plus récent. */
export function searchExchanges(db: DatabaseSync, q: HistoryQuery): Exchange[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.role) { where.push("role = ?"); params.push(q.role); }
  const from = q.since ? dayStartIso(q.since) : undefined;
  const to = q.until ? dayStartIso(q.until, 1) : undefined;
  if (from) { where.push("t >= ?"); params.push(from); }
  if (to) { where.push("t < ?"); params.push(to); }
  const fts = ftsQuery(q.query);
  const limit = Math.max(1, Math.min(Math.trunc(q.limit) || 5, 20));

  let rows: HistoryRow[];
  if (fts) {
    rows = db.prepare(`SELECT rowid, t, role, text, session FROM history WHERE history MATCH ?${where.map((w) => ` AND ${w}`).join("")} ORDER BY rank LIMIT ?`)
      .all(fts, ...params, limit) as unknown as HistoryRow[];
  } else if (from || to) {
    rows = db.prepare(`SELECT rowid, t, role, text, session FROM history WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, limit) as unknown as HistoryRow[];
  } else return [];

  const next = db.prepare(`SELECT rowid, t, role, text, session FROM history WHERE rowid > ? AND rowid <= ? AND session = ? ORDER BY rowid LIMIT 1`);
  const prev = db.prepare(`SELECT rowid, t, role, text, session FROM history WHERE rowid < ? AND rowid >= ? AND session = ? ORDER BY rowid DESC LIMIT 1`);
  const seen = new Set<string>();
  const out: Exchange[] = [];
  for (const r of rows) {
    let user: HistoryRow | undefined, assistant: HistoryRow | undefined;
    if (r.role === "user") {
      user = r;
      const n = next.get(r.rowid, r.rowid + NEIGHBOUR_WINDOW, r.session) as unknown as HistoryRow | undefined;
      if (n?.role === "assistant") assistant = n;
    } else {
      assistant = r;
      const p = prev.get(r.rowid, r.rowid - NEIGHBOUR_WINDOW, r.session) as unknown as HistoryRow | undefined;
      if (p?.role === "user") user = p;
    }
    const key = `${user?.rowid ?? "-"}/${assistant?.rowid ?? "-"}`;
    if (seen.has(key)) {
      const e = out.find((x) => `${x.user?.rowid ?? "-"}/${x.assistant?.rowid ?? "-"}` === key);
      if (e && !e.matched.includes(r.role as "user" | "assistant")) e.matched.push(r.role as "user" | "assistant");
      continue;
    }
    seen.add(key);
    out.push({ t: (user ?? assistant)!.t, ...(user ? { user } : {}), ...(assistant ? { assistant } : {}), matched: [r.role as "user" | "assistant"] });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

/** Les échanges en texte, avec la date locale, sans dépasser TOTAL_MAX caractères. */
export function formatExchanges(list: Exchange[]): Text {
  const side = (e: Exchange, role: "user" | "assistant", label: { fr: string; en: string }) => {
    const row = e[role];
    if (!row) return undefined;
    const text = clip(row.text.replace(/\s+/g, " ").trim(), e.matched.includes(role) ? HIT_MAX : NEIGHBOUR_MAX);
    return { fr: `${label.fr} : ${text}`, en: `${label.en} : ${text}` };
  };
  const blocks = list.map((e) => {
    const u = side(e, "user", { fr: "Utilisateur", en: "User" });
    const a = side(e, "assistant", { fr: "Assistant", en: "Assistant" });
    return { fr: [`[${localStamp(e.t)}]`, u?.fr, a?.fr].filter(Boolean).join("\n"), en: [`[${localStamp(e.t)}]`, u?.en, a?.en].filter(Boolean).join("\n") };
  });
  const join = (lang: "fr" | "en"): string => {
    let total = 0;
    const kept: string[] = [];
    for (const b of blocks) {
      if (kept.length && total + b[lang].length > TOTAL_MAX) break;
      kept.push(b[lang]); total += b[lang].length + 2;
    }
    const more = blocks.length - kept.length;
    return kept.join("\n\n") + (more > 0 ? (lang === "fr" ? `\n\n(… ${more} autre(s) résultat(s) non montré(s))` : `\n\n(… ${more} more result(s) not shown)`) : "");
  };
  return T(join("fr"), join("en"));
}
