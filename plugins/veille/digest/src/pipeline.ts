// Un passage de veille : collecter → pré-trier en code → noter avec le modèle (par lots) → synthèse → document Markdown.
// Ne connaît ni l'horloge (le Planificateur la lance) ni les corps (le noyau montre le document).
import { T, TextError, errorText, tr, type CompletionService, type SearchService } from "@floppy/core";
import { fetchFeed, hostOf, clean } from "./feeds.ts";
import { pretri, normUrl, type Article } from "./pretri.ts";
import type { Prefs } from "./prefs.ts";
import type { DigestArticle } from "./store.ts";

export interface Interet {
  id: string;
  nom: string;
  /** Ce que l'utilisateur cherche dans ce sujet (dit au modèle). */
  description: string;
  flux: string[];
  requetes: string[];
  /** Articles gardés au plus dans le digest. */
  max: number;
}

export interface PipelineConfig {
  /** Note minimale (0-10) pour garder un article. */
  seuil: number;
  /** Articles par appel au modèle. */
  lot: number;
  /** Articles au plus envoyés au modèle, par centre d'intérêt. */
  maxVersModele: number;
  /** Sans passage précédent : on remonte de ce nombre de jours. */
  fenetreJours: number;
}

export interface PipelineDeps {
  interets: Interet[];
  prefs(interet: string): Prefs;
  dejaVu(url: string): boolean;
  completion: CompletionService;
  search?: SearchService;
  fetch?: typeof fetch;
  now: Date;
  dernierPassage?: Date;
  cfg: PipelineConfig;
  signal?: AbortSignal;
  log(level: "info" | "warn", msg: string): void;
  /** Langue de l'assistant (digest, résumés, erreurs des sources). Défaut : français. */
  lang?: string;
}

export interface Noted extends Article {
  score: number;
  resume: string;
}

export interface PipelineResult {
  /** Articles gardés, par centre d'intérêt (ordre des intérêts), triés par note. */
  sections: { interet: Interet; synthese: string; articles: Noted[] }[];
  /** Tous les articles nouveaux vus pendant ce passage (à marquer « vus » si le passage réussit). */
  vus: { url: string; titre: string; interet: string }[];
  stats: { collectes: number; versModele: number; gardes: number; erreurs: string[]; retires: Record<string, number> };
}

export async function runPipeline(d: PipelineDeps): Promise<PipelineResult> {
  const erreurs: string[] = [];
  const lang = d.lang ?? "fr";
  const msg = (e: unknown) => tr(errorText(e), lang);
  // 1. Collecte : flux et recherches, chaque source avec son délai. Une source en panne n'arrête pas les autres.
  const all: Article[] = [];
  const depuis = d.dernierPassage ? new Date(d.dernierPassage.getTime() - 86_400_000) : new Date(d.now.getTime() - d.cfg.fenetreJours * 86_400_000);
  await Promise.all(d.interets.flatMap((it) => [
    ...it.flux.map(async (url) => {
      try {
        const items = await fetchFeed(url, { ...(d.fetch ? { fetch: d.fetch } : {}), ...(d.signal ? { signal: d.signal } : {}) });
        for (const x of items.slice(0, 50)) all.push({ ...x, interet: it.id });
      } catch (e) { erreurs.push(tr(T(`flux ${hostOf(url)} : ${msg(e)}`, `feed ${hostOf(url)}: ${msg(e)}`), lang)); }
    }),
    ...(d.search ? it.requetes.map(async (q) => {
      try {
        const hits = await d.search!.search(q, { max: 10, depuis, ...(d.signal ? { signal: d.signal } : {}) });
        for (const h of hits) all.push({ titre: clean(h.titre), url: h.url, source: h.source ?? hostOf(h.url), ...(h.date ? { date: h.date } : {}), extrait: clean(h.resume ?? "").slice(0, 300), interet: it.id });
      } catch (e) { erreurs.push(tr(T(`recherche « ${q} » : ${msg(e)}`, `search “${q}”: ${msg(e)}`), lang)); }
    }) : []),
  ]));
  for (const e of erreurs) d.log("warn", e);
  abortIf(d.signal);

  // 2. Pré-tri en code.
  const { gardes, retires } = pretri(all, { dejaVu: d.dejaVu, depuis, bannis: (i) => d.prefs(i).bannis, max: d.cfg.maxVersModele });
  const vus = all.filter((a) => /^https?:\/\//i.test(a.url)).map((a) => ({ url: normUrl(a.url), titre: a.titre, interet: a.interet }));
  d.log("info", `collectés ${all.length}, vers le modèle ${gardes.length} (retirés : ${JSON.stringify(retires)})`);

  // 3. Note par le modèle, par lots, centre d'intérêt par centre d'intérêt (le prompt dit ce qui compte pour CE sujet).
  const sections: PipelineResult["sections"] = [];
  for (const it of d.interets) {
    const mine = gardes.filter((a) => a.interet === it.id);
    if (!mine.length) continue;
    const noted: Noted[] = [];
    for (let i = 0; i < mine.length; i += d.cfg.lot) {
      abortIf(d.signal);
      const lot = mine.slice(i, i + d.cfg.lot).map((a, k) => ({ ...a, id: k + 1 }));
      const notes = await noter(d, it, lot);
      for (const a of lot) {
        const n = notes.get(a.id!);
        if (n && n.score >= d.cfg.seuil) noted.push({ ...a, score: n.score, resume: n.resume || a.extrait });
      }
    }
    noted.sort((x, y) => y.score - x.score);
    const top = noted.slice(0, it.max);
    if (!top.length) continue;
    // 4. Synthèse courte du sujet (si elle échoue, le digest reste utile sans).
    let synthese = "";
    try { synthese = await synthetiser(d, it, top); } catch (e) { d.log("warn", `synthèse ${it.nom} : ${msg(e)}`); }
    sections.push({ interet: it, synthese, articles: top });
  }
  const versModele = gardes.length;
  return { sections, vus, stats: { collectes: all.length, versModele, gardes: sections.reduce((n, s) => n + s.articles.length, 0), erreurs, retires } };
}

const SCHEMA = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, score: { type: "number", minimum: 0, maximum: 10 }, resume: { type: "string" } },
        required: ["id", "score", "resume"],
      },
    },
  },
  required: ["articles"],
};

/** Consignes du tri, avec les préférences de l'utilisateur, dans la langue de l'assistant. Exporté pour les tests. */
export function triSystem(it: Interet, p: Prefs, lang = "fr"): string {
  if (lang === "en") {
    return [
      `You sort articles for the user's news watch on the topic “${it.nom}”.`,
      it.description ? `What they are looking for: ${it.description}` : "",
      p.aime.length ? `They like: ${p.aime.join("; ")}.` : "",
      p.evite.length ? `They do not want (score low): ${p.evite.join("; ")}.` : "",
      p.exemples.length ? `Articles they already rated:\n${p.exemples.map((e) => `${e.avis === "+" ? "[liked]" : "[disliked]"} ${e.titre}`).join("\n")}` : "",
      "For each article, give a score from 0 (no interest for them) to 10 (must read). Be demanding: 6 means “really useful for them”. An ad, an off-topic or too general article: less than 3.",
      "For each article, write a summary in English of 1 or 2 sentences, from the title and the excerpt only. Do not make anything up.",
      "Answer with all the articles, with their id.",
    ].filter(Boolean).join("\n");
  }
  const lines = [
    `Tu tries des articles pour la veille de l'utilisateur sur le sujet « ${it.nom} ».`,
    it.description ? `Ce qu'il cherche : ${it.description}` : "",
    p.aime.length ? `Il aime : ${p.aime.join(" ; ")}.` : "",
    p.evite.length ? `Il ne veut pas (note bas) : ${p.evite.join(" ; ")}.` : "",
    p.exemples.length ? `Articles qu'il a déjà notés :\n${p.exemples.map((e) => `${e.avis === "+" ? "[aimé]" : "[pas aimé]"} ${e.titre}`).join("\n")}` : "",
    "Pour chaque article, donne une note de 0 (aucun intérêt pour lui) à 10 (à lire absolument). Sois exigeant : 6 veut dire « vraiment utile pour lui ». Une publicité, un article hors sujet ou trop général : moins de 3.",
    "Pour chaque article, écris un résumé en français de 1 ou 2 phrases, d'après le titre et l'extrait seulement. N'invente rien.",
    "Réponds avec tous les articles, avec leur id.",
  ];
  return lines.filter(Boolean).join("\n");
}

async function noter(d: PipelineDeps, it: Interet, lot: Article[]): Promise<Map<number, { score: number; resume: string }>> {
  const prompt = lot.map((a) => `[${a.id}] ${a.titre} — ${a.source}${a.date ? ` — ${a.date.slice(0, 10)}` : ""}\n${a.extrait}`).join("\n\n");
  const r = await d.completion.complete({ system: triSystem(it, d.prefs(it.id), d.lang), prompt, schema: SCHEMA, ...(d.signal ? { signal: d.signal } : {}) });
  const list = (r.json as { articles?: unknown } | undefined)?.articles;
  const out = new Map<number, { score: number; resume: string }>();
  if (!Array.isArray(list)) throw new TextError(T("le modèle n'a pas rendu la liste des articles", "the model did not return the list of articles"));
  for (const x of list) {
    const id = Number((x as { id?: unknown }).id);
    const score = Number((x as { score?: unknown }).score);
    if (Number.isFinite(id) && Number.isFinite(score)) out.set(id, { score, resume: String((x as { resume?: unknown }).resume ?? "").trim() });
  }
  return out;
}

async function synthetiser(d: PipelineDeps, it: Interet, list: Noted[]): Promise<string> {
  const r = await d.completion.complete({
    system: d.lang === "en"
      ? `Write in English 2 or 3 sentences that say what is moving on the topic “${it.nom}”, based on these articles. No title, no list, no link. Do not make anything up.`
      : `Écris en français 2 ou 3 phrases qui disent ce qui bouge sur le sujet « ${it.nom} », d'après ces articles. Pas de titre, pas de liste, pas de lien. N'invente rien.`,
    prompt: list.map((a) => `- ${a.titre} : ${a.resume}`).join("\n"),
    ...(d.signal ? { signal: d.signal } : {}),
  });
  return r.text.trim();
}

const MOIS_COURT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dateFr(d: Date): string {
  return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`;
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
export function digestMarkdown(r: PipelineResult, now: Date, docId = "", lang = "fr"): { titre: string; markdown: string; articles: DigestArticle[] } {
  const en = lang === "en";
  const titre = en ? `News watch, ${dateEn(now)}` : `Veille du ${dateFr(now)}`;
  const articles: DigestArticle[] = [];
  const parts = [`# ${titre}`, ""];
  const n = r.stats.gardes;
  const ns = r.sections.length;
  parts.push(en
    ? `${n} article${n > 1 ? "s" : ""} on ${ns} topic${ns > 1 ? "s" : ""}. To fine-tune, say for example “number 3 doesn't interest me” or “no more articles about crypto”.`
    : `${n} article${n > 1 ? "s" : ""} sur ${ns} sujet${ns > 1 ? "s" : ""}. Pour affiner, dis par exemple « le 3 ne m'intéresse pas » ou « plus jamais d'articles sur la crypto ».`, "");
  let num = 0;
  for (const s of r.sections) {
    parts.push(`## ${esc(s.interet.nom)}`, "");
    if (s.synthese) parts.push(s.synthese, "");
    for (const a of s.articles) {
      num++;
      articles.push({ numero: num, doc: docId, interet: s.interet.id, titre: a.titre, url: a.url, source: a.source, resume: a.resume });
      const dt = a.date ? new Date(a.date) : undefined;
      const when = dt ? (en ? ` · ${MONTHS_SHORT[dt.getMonth()]} ${dt.getDate()}` : ` · ${dt.getDate()} ${MOIS_COURT[dt.getMonth()]}`) : "";
      parts.push(`**${num}. ${esc(a.titre)}**  `, `*${esc(a.source)}${when}* · ${en ? "score" : "note"} ${Math.round(a.score)}/10  `, `${a.resume} [${en ? "Read the article" : "Lire l'article"}](${href(a.url)})`, "");
    }
  }
  if (r.stats.erreurs.length) parts.push("---", "", en ? `*Sources down: ${r.stats.erreurs.map(esc).join("; ")}.*` : `*Sources en panne : ${r.stats.erreurs.map(esc).join(" ; ")}.*`, "");
  return { titre, markdown: parts.join("\n"), articles };
}

function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new TextError(T("arrêtée", "stopped"));
}
