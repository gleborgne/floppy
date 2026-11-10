// Pré-tri en code, avant le modèle : moins d'articles à lire = moins cher, plus rapide, plus juste.
// Ordre : déjà vus → trop vieux → mots bannis → doublons entre sources → plafond (les plus récents).
import { wordsKey } from "@floppy/core";

export interface Article {
  /** Numéro du lot (rempli au moment du tri). */
  id?: number;
  title: string;
  url: string;
  source: string;
  date?: string;
  excerpt: string;
  /** Id du centre d'intérêt. */
  interest: string;
}

export interface PresortResult {
  kept: Article[];
  /** Compteurs, pour le journal et le résumé. */
  removed: { seen: number; old: number; banned: number; duplicates: number; cap: number; invalid: number };
}

/** URL sans traqueurs (utm_*, fbclid…), sans ancre, sans « www. », sans / final : sert de clé « déjà vu ». */
export function normUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.replace(/^www\./, "");
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString().replace(/^http:/, "https:");
  } catch {
    return url.trim();
  }
}

/** Minuscules, sans accents ni ponctuation. */
export function norm(s: string): string {
  return wordsKey(s);
}

const STOP = new Set("le la les un une des de du d l et ou a au aux en dans sur pour par avec sans est sont the a an of to in on for and or is are with".split(" "));

function words(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}

/** Deux titres presque identiques (même dépêche reprise par deux sites). */
export function sameStory(a: string, b: string): boolean {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size) >= 0.8 && common >= 3;
}

/** Le texte contient-il ce mot ou cette expression (mots entiers, sans accents) ? */
export function mentions(text: string, term: string): boolean {
  const t = ` ${norm(text)} `;
  const w = norm(term);
  return !!w && t.includes(` ${w} `);
}

export function presort(items: Article[], opts: {
  alreadySeen: (url: string) => boolean;
  /** Articles publiés avant cette date : retirés (sans date : gardés). */
  since: Date;
  banned: (interest: string) => string[];
  max: number;
}): PresortResult {
  const removed = { seen: 0, old: 0, banned: 0, duplicates: 0, cap: 0, invalid: 0 };
  const seenNow = new Set<string>();
  const out: Article[] = [];
  for (const a of items) {
    if (!/^https?:\/\//i.test(a.url) || !a.title) { removed.invalid++; continue; }
    const key = normUrl(a.url);
    if (seenNow.has(key) || opts.alreadySeen(key)) { removed.seen++; continue; }
    seenNow.add(key);
    if (a.date && Date.parse(a.date) < opts.since.getTime()) { removed.old++; continue; }
    if (opts.banned(a.interest).some((b) => mentions(`${a.title} ${a.excerpt}`, b))) { removed.banned++; continue; }
    if (out.some((o) => sameStory(o.title, a.title))) { removed.duplicates++; continue; }
    out.push(a);
  }
  // Plafond par centre d'intérêt : les plus récents d'abord (sans date : à la fin).
  const byInterest = new Map<string, Article[]>();
  for (const a of out) byInterest.set(a.interest, [...(byInterest.get(a.interest) ?? []), a]);
  const kept: Article[] = [];
  for (const list of byInterest.values()) {
    list.sort((x, y) => (y.date ? Date.parse(y.date) : 0) - (x.date ? Date.parse(x.date) : 0));
    kept.push(...list.slice(0, opts.max));
    removed.cap += Math.max(0, list.length - opts.max);
  }
  return { kept, removed };
}
