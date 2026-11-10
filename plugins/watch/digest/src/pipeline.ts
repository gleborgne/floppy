// Un passage de veille : collecter → pré-trier en code → noter avec le modèle (par lots) → document Markdown.
// Ne connaît ni l'horloge (le Planificateur la lance) ni les corps (le noyau montre le document).
import { T, TextError, errorText, tr } from "@floppy/core";
import type { CompletionService, SearchService } from "@floppy/contracts";
import { fetchFeed, hostOf, clean, type FeedFetch } from "./feeds.ts";
import { presort, normUrl, type Article } from "./presort.ts";
import type { Prefs } from "./prefs.ts";
import type { DigestArticle } from "./store.ts";

export interface Interest {
  id: string;
  name: string;
  /** Ce que l'utilisateur cherche dans ce sujet (dit au modèle). */
  description: string;
  feeds: string[];
  queries: string[];
  /** Articles gardés au plus dans le digest. */
  max: number;
}

export interface PipelineConfig {
  /** Note minimale (0-10) pour garder un article. */
  threshold: number;
  /** Articles par appel au modèle. */
  batch: number;
  /** Articles au plus envoyés au modèle, par centre d'intérêt. */
  maxToModel: number;
  /** Sans passage précédent : on remonte de ce nombre de jours. */
  windowDays: number;
}

export interface PipelineDeps {
  interests: Interest[];
  prefs(interest: string): Prefs;
  alreadySeen(url: string): boolean;
  completion: CompletionService;
  search?: SearchService;
  fetch: FeedFetch;
  now: Date;
  lastRun?: Date;
  cfg: PipelineConfig;
  signal?: AbortSignal;
  log(level: "info" | "warn", msg: string): void;
  /** Langue de l'assistant (digest, résumés, erreurs des sources). Défaut : français. */
  lang?: string;
}

export interface Noted extends Article {
  score: number;
  summary: string;
}

export interface PipelineResult {
  /** Articles gardés, par centre d'intérêt (ordre des intérêts), triés par note. */
  sections: { interest: Interest; articles: Noted[] }[];
  /** Tous les articles nouveaux vus pendant ce passage (à marquer « vus » si le passage réussit). */
  seen: { url: string; title: string; interest: string }[];
  stats: { collected: number; toModel: number; kept: number; errors: string[]; removed: Record<string, number> };
}

export async function runPipeline(d: PipelineDeps): Promise<PipelineResult> {
  const errors: string[] = [];
  const lang = d.lang ?? "fr";
  const msg = (e: unknown) => tr(errorText(e), lang);
  // 1. Collecte : flux et recherches, chaque source avec son délai. Une source en panne n'arrête pas les autres.
  const all: Article[] = [];
  const since = d.lastRun ? new Date(d.lastRun.getTime() - 86_400_000) : new Date(d.now.getTime() - d.cfg.windowDays * 86_400_000);
  await Promise.all(d.interests.flatMap((it) => [
    ...it.feeds.map(async (url) => {
      try {
        const items = await fetchFeed(url, { fetch: d.fetch, ...(d.signal ? { signal: d.signal } : {}) });
        for (const x of items.slice(0, 50)) all.push({ ...x, interest: it.id });
      } catch (e) { errors.push(tr(T(`flux ${hostOf(url)} : ${msg(e)}`, `feed ${hostOf(url)}: ${msg(e)}`), lang)); }
    }),
    ...(d.search ? it.queries.map(async (q) => {
      try {
        const hits = await d.search!.search(q, { max: 10, since: since, ...(d.signal ? { signal: d.signal } : {}) });
        for (const h of hits) all.push({ title: clean(h.title), url: h.url, source: h.source ?? hostOf(h.url), ...(h.date ? { date: h.date } : {}), excerpt: clean(h.summary ?? "").slice(0, 300), interest: it.id });
      } catch (e) { errors.push(tr(T(`recherche « ${q} » : ${msg(e)}`, `search “${q}”: ${msg(e)}`), lang)); }
    }) : []),
  ]));
  for (const e of errors) d.log("warn", e);
  abortIf(d.signal);

  // 2. Pré-tri en code.
  const { kept, removed } = presort(all, { alreadySeen: d.alreadySeen, since, banned: (i) => d.prefs(i).banned, max: d.cfg.maxToModel });
  const seen = all.filter((a) => /^https?:\/\//i.test(a.url)).map((a) => ({ url: normUrl(a.url), title: a.title, interest: a.interest }));
  d.log("info", `collectés ${all.length}, vers le modèle ${kept.length} (retirés : ${JSON.stringify(removed)})`);

  // 3. Note par le modèle, par lots, centre d'intérêt par centre d'intérêt (le prompt dit ce qui compte pour CE sujet).
  const sections: PipelineResult["sections"] = [];
  for (const it of d.interests) {
    const mine = kept.filter((a) => a.interest === it.id);
    if (!mine.length) continue;
    const noted: Noted[] = [];
    for (let i = 0; i < mine.length; i += d.cfg.batch) {
      abortIf(d.signal);
      const lot = mine.slice(i, i + d.cfg.batch).map((a, k) => ({ ...a, id: k + 1 }));
      const notes = await rate(d, it, lot);
      for (const a of lot) {
        const n = notes.get(a.id!);
        if (n && n.score >= d.cfg.threshold) noted.push({ ...a, score: n.score, summary: n.summary || a.excerpt });
      }
    }
    noted.sort((x, y) => y.score - x.score);
    const top = noted.slice(0, it.max);
    if (!top.length) continue;
    sections.push({ interest: it, articles: top });
  }
  const toModel = kept.length;
  return { sections, seen, stats: { collected: all.length, toModel, kept: sections.reduce((n, s) => n + s.articles.length, 0), errors, removed } };
}

const SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, score: { type: "number", minimum: 0, maximum: 10 }, summary: { type: "string" } },
        required: ["id", "score", "summary"],
      },
    },
  },
  required: ["articles"],
};

/** Consignes du tri, avec les préférences de l'utilisateur, dans la langue de l'assistant. Exporté pour les tests. */
export function sortSystem(it: Interest, p: Prefs, lang = "fr"): string {
  if (lang === "en") {
    return [
      `You sort articles for the user's news watch on the topic “${it.name}”.`,
      it.description ? `What they are looking for: ${it.description}` : "",
      p.likes.length ? `They like: ${p.likes.join("; ")}.` : "",
      p.avoids.length ? `They do not want (score low): ${p.avoids.join("; ")}.` : "",
      p.examples.length ? `Articles they already rated:\n${p.examples.map((e) => `${e.feedback === "+" ? "[liked]" : "[disliked]"} ${e.title}`).join("\n")}` : "",
      "For each article, give a score from 0 (no interest for them) to 10 (must read). Be demanding: 6 means “really useful for them”. An ad, an off-topic or too general article: less than 3.",
      "For each article, write a summary in English of 1 or 2 sentences, from the title and the excerpt only. Do not make anything up.",
      "Answer with all the articles, with their id.",
    ].filter(Boolean).join("\n");
  }
  const lines = [
    `Tu tries des articles pour la veille de l'utilisateur sur le sujet « ${it.name} ».`,
    it.description ? `Ce qu'il cherche : ${it.description}` : "",
    p.likes.length ? `Il aime : ${p.likes.join(" ; ")}.` : "",
    p.avoids.length ? `Il ne veut pas (note bas) : ${p.avoids.join(" ; ")}.` : "",
    p.examples.length ? `Articles qu'il a déjà notés :\n${p.examples.map((e) => `${e.feedback === "+" ? "[aimé]" : "[pas aimé]"} ${e.title}`).join("\n")}` : "",
    "Pour chaque article, donne une note de 0 (aucun intérêt pour lui) à 10 (à lire absolument). Sois exigeant : 6 veut dire « vraiment utile pour lui ». Une publicité, un article hors sujet ou trop général : moins de 3.",
    "Pour chaque article, écris un résumé en français de 1 ou 2 phrases, d'après le titre et l'extrait seulement. N'invente rien.",
    "Réponds avec tous les articles, avec leur id.",
  ];
  return lines.filter(Boolean).join("\n");
}

async function rate(d: PipelineDeps, it: Interest, lot: Article[]): Promise<Map<number, { score: number; summary: string }>> {
  const prompt = lot.map((a) => `[${a.id}] ${a.title} — ${a.source}${a.date ? ` — ${a.date.slice(0, 10)}` : ""}\n${a.excerpt}`).join("\n\n");
  const r = await d.completion.complete({ system: sortSystem(it, d.prefs(it.id), d.lang), prompt, schema: SCHEMA, ...(d.signal ? { signal: d.signal } : {}) });
  const list = (r.json as { articles?: unknown } | undefined)?.articles;
  const out = new Map<number, { score: number; summary: string }>();
  if (!Array.isArray(list)) throw new TextError(T("le modèle n'a pas rendu la liste des articles", "the model did not return the list of articles"));
  for (const x of list) {
    const id = Number((x as { id?: unknown }).id);
    const score = Number((x as { score?: unknown }).score);
    if (Number.isFinite(id) && Number.isFinite(score)) out.set(id, { score, summary: String((x as { summary?: unknown }).summary ?? "").trim() });
  }
  return out;
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function dateFr(d: Date): string {
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
}

export function dateEn(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Échappe ce qui casserait le Markdown d'un titre. */
function esc(s: string): string {
  return s.replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

/** Adresse sûre dans un lien Markdown (les parenthèses et espaces casseraient le lien). */
function href(url: string): string {
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Le document du digest, assemblé en code (pas par le modèle) : numéros uniques dans tout le document,
 * pour « le 3 ne m'intéresse pas ». Rend aussi la liste numérotée à garder en base.
 */
export function digestMarkdown(r: PipelineResult, now: Date, docId = "", lang = "fr"): { title: string; markdown: string; articles: DigestArticle[] } {
  const en = lang === "en";
  const title = en ? `News watch, ${dateEn(now)}` : `Veille du ${dateFr(now)}`;
  const articles: DigestArticle[] = [];
  const parts = [`# ${title}`, ""];
  const n = r.stats.kept;
  const ns = r.sections.length;
  parts.push(en
    ? `${n} article${n > 1 ? "s" : ""} on ${ns} topic${ns > 1 ? "s" : ""}. To fine-tune, say for example “number 3 doesn't interest me” or “no more articles about crypto”.`
    : `${n} article${n > 1 ? "s" : ""} sur ${ns} sujet${ns > 1 ? "s" : ""}. Pour affiner, dis par exemple « le 3 ne m'intéresse pas » ou « plus jamais d'articles sur la crypto ».`, "");
  let num = 0;
  for (const s of r.sections) {
    parts.push(`## ${esc(s.interest.name)}`, "");
    for (const a of s.articles) {
      num++;
      articles.push({ number: num, doc: docId, interest: s.interest.id, title: a.title, url: a.url, source: a.source, summary: a.summary });
      const dt = a.date ? new Date(a.date) : undefined;
      const when = dt && Number.isFinite(dt.getTime())
        ? (en ? ` · Published on ${dateEn(dt)}` : ` · Publié le ${dateFr(dt)}`)
        : (en ? " · Publication date unavailable" : " · Date de publication indisponible");
      parts.push(`**${num}. ${esc(a.title)}**  `, `*${esc(a.source)}${when}* · ${en ? "score" : "note"} ${Math.round(a.score)}/10  `, `${a.summary} [${en ? "Read the article" : "Lire l'article"}](${href(a.url)})`, "");
    }
  }
  if (r.stats.errors.length) parts.push("---", "", en ? `*Sources down: ${r.stats.errors.map(esc).join("; ")}.*` : `*Sources en panne : ${r.stats.errors.map(esc).join(" ; ")}.*`, "");
  return { title, markdown: parts.join("\n"), articles };
}

function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new TextError(T("arrêtée", "stopped"));
}
