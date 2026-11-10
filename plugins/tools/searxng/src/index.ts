// Plugin `searxng` : recherche sur internet avec un SearXNG (moteur de méta-recherche libre, chez toi ou ailleurs).
// C'est une « application » : l'utilisateur l'ajoute dans Réglages → Connecteurs (manifest.addable).
//
// - Service `search` (offert par ctx.offer) : pour les autres plugins (la Veille), choisi dans un slot.
// - Outil `search_searxng(question)` : la même recherche, pour le cerveau (liste courte : titre, site, lien, résumé).
// - Un seul code pour les deux. Rien n'est « cloud » : les requêtes ne partent que vers l'adresse donnée.
// - SearXNG doit accepter le format JSON : dans son settings.yml, `search.formats: [html, json]`.
import { z } from "zod";
import { definePlugin, T, TextError, type Text } from "@floppy/core";
import type { SearchHit, SearchService } from "@floppy/contracts";
import { SEARXNG } from "./logo.ts";

const t = (fr: string, en: string): Text => ({ fr, en });

export const Config = z.object({
  /** Adresse de SearXNG, sans /search. */
  url: z.string().default("http://localhost:8888"),
  language: z.string().default("fr"),
  categories: z.array(z.string()).default(["general"]),
  timeoutMs: z.number().min(500).default(10000),
  /** Nombre maximum de résultats gardés. */
  max: z.number().min(1).max(50).default(10),
});
type Config = z.infer<typeof Config>;

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface RawResult { title?: unknown; url?: unknown; content?: unknown; publishedDate?: unknown; engine?: unknown; parsed_url?: unknown }

/** `time_range` de SearXNG : la plus petite durée qui couvre « depuis ». */
export function timeRange(since: Date, now = new Date()): "day" | "week" | "month" | "year" | undefined {
  const days = (now.getTime() - since.getTime()) / 86_400_000;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return undefined;
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return undefined; }
}

function toHit(r: RawResult): SearchHit | undefined {
  const url = typeof r.url === "string" ? r.url : "";
  if (!/^https?:\/\//i.test(url)) return undefined;
  const parsed = Array.isArray(r.parsed_url) ? String(r.parsed_url[1] ?? "") : "";
  const hit: SearchHit = { title: String(r.title ?? url).trim().slice(0, 200) || url, url };
  const summary = typeof r.content === "string" ? r.content.trim().slice(0, 400) : "";
  if (summary) hit.summary = summary;
  const source = hostOf(url) ?? (parsed || (typeof r.engine === "string" ? r.engine : undefined));
  if (source) hit.source = source;
  if (typeof r.publishedDate === "string" && !Number.isNaN(Date.parse(r.publishedDate))) hit.date = new Date(r.publishedDate).toISOString();
  return hit;
}

/** Interroge SearXNG. Les erreurs ont un message clair, en français et en anglais (TextError). */
export async function searxngSearch(
  cfg: Config, q: string, opts: { max?: number; since?: Date; signal?: AbortSignal } = {}, fetchImpl: FetchLike,
): Promise<SearchHit[]> {
  const base = cfg.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new TextError(T("L'adresse de SearXNG doit commencer par http:// ou https://.", "The SearXNG address must start with http:// or https://."));
  const u = new URL(`${base}/search`);
  u.searchParams.set("q", q);
  u.searchParams.set("format", "json");
  u.searchParams.set("language", cfg.language);
  if (cfg.categories.length) u.searchParams.set("categories", cfg.categories.join(","));
  const range = opts.since ? timeRange(opts.since) : undefined;
  if (range) u.searchParams.set("time_range", range);
  const signals = [AbortSignal.timeout(cfg.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
  let r: Response;
  try {
    r = await fetchImpl(u, { headers: { accept: "application/json" }, signal: AbortSignal.any(signals) });
  } catch (e) {
    if (opts.signal?.aborted) throw new TextError(T("annulé", "cancelled"));
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new TextError(T(`SearXNG ne répond pas (délai de ${Math.round(cfg.timeoutMs / 1000)} s dépassé).`, `SearXNG is not answering (${Math.round(cfg.timeoutMs / 1000)} s timeout).`));
    throw new TextError(T(`Impossible de joindre SearXNG à ${base} : ${e instanceof Error ? e.message : String(e)}`, `Cannot reach SearXNG at ${base}: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (r.status === 403) throw new TextError(T("SearXNG refuse le format JSON (erreur 403) : ajoute « json » dans search.formats de son settings.yml.", "SearXNG refuses the JSON format (error 403): add “json” to search.formats in its settings.yml."));
  if (!r.ok) throw new TextError(T(`SearXNG répond avec une erreur ${r.status}.`, `SearXNG answers with error ${r.status}.`));
  let j: { results?: RawResult[] };
  try {
    j = (await r.json()) as { results?: RawResult[] };
  } catch {
    throw new TextError(T("SearXNG n'a pas répondu en JSON : vérifie l'adresse et que search.formats contient « json ».", "SearXNG did not answer in JSON: check the address and that search.formats contains “json”."));
  }
  if (!j || !Array.isArray(j.results)) throw new TextError(T("Réponse inattendue de SearXNG (pas de liste de résultats).", "Unexpected answer from SearXNG (no result list)."));
  const hits = j.results.map(toHit).filter((x): x is SearchHit => !!x);
  return hits.slice(0, Math.min(opts.max ?? cfg.max, cfg.max));
}

/** `fetchImpl` : faux réseau des tests ; sinon le `ctx.fetch` du plugin. */
export function createSearxngPlugin(fetchImpl?: FetchLike) {
  return definePlugin<Config>({
    manifest: {
      id: "searxng",
      version: "0.1.0",
      licence: "MIT",
      sections: [
        { id: "connectors", label: { fr: "Connecteurs", en: "Connectors" } },
      ],
      description: "Recherche sur internet avec un SearXNG (adresse à donner).",
      provides: ["search"],
      permissions: { net: ["*"] },
      addable: {
        section: "connectors",
        single: true,
        logo: SEARXNG,
        label: t("SearXNG", "SearXNG"),
        description: t(
          "Floppy cherche sur internet avec ton SearXNG. Il doit accepter le format JSON : dans son settings.yml, mets search.formats: [html, json].",
          "Floppy searches the internet with your SearXNG. It must allow the JSON format: in its settings.yml, set search.formats: [html, json].",
        ),
        aliases: ["searxng", "recherche web", "méta-recherche"],
        fields: [
          { key: "url", label: t("Adresse de SearXNG", "SearXNG address"), type: "text", required: true, default: "http://localhost:8888", placeholder: t("http://localhost:8888", "http://localhost:8888") },
          { key: "language", label: t("Langue des résultats", "Results language"), type: "text", default: "fr" },
          { key: "categories", label: t("Catégories", "Categories"), type: "list", default: ["general"], advanced: true, hint: t("general, news, science…", "general, news, science…") },
          { key: "max", label: t("Nombre de résultats", "Number of results"), type: "number", default: 10, min: 1, max: 50, advanced: true },
          { key: "timeoutMs", label: t("Délai (ms)", "Timeout (ms)"), type: "number", default: 10000, min: 500, advanced: true },
        ],
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const service: SearchService = {
        label: "SearXNG", cloud: false,
        search: (q, opts) => searxngSearch(cfg, q, opts, http),
      };
      // Borne = réglage timeoutMs (10 s par défaut), pour la réponse entière : ctx.fetch ne doit pas la raccourcir à 30 s.
      // ctx du plugin (pas du fork) : l'outil du cerveau cherche aussi sans passer par le slot.
      const http: FetchLike = fetchImpl ?? ((u, i) => ctx.fetch(u, { ...i, timeoutMs: cfg.timeoutMs }));
      ctx.offer("search", {
        items: () => [{ id: "searxng", label: "SearXNG" }],
        start(f) { f.provide("search", service); },
      });
      ctx.tools.register([{
        name: "search_searxng",
        description: "Cherche sur internet avec SearXNG (actualité, documentation, tout ce qui n'est pas dans tes autres outils). Rend une liste de résultats : titre, site, lien, résumé. Choisis les plus utiles et réponds en une ou deux phrases ; ne lis pas les liens à voix haute. question : la recherche, en clair.",
        inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
        level: "read",
        handler: async (a, meta) => {
          const question = String(a.question ?? "").trim().slice(0, 500);
          if (!question) return { status: "failed", text: "Question vide." };
          const t0 = Date.now();
          let hits: SearchHit[];
          try {
            hits = await service.search(question, { max: 8, signal: meta.signal });
          } catch (e) {
            return { status: "failed", text: `La recherche n'a pas marché : ${e instanceof Error ? e.message : String(e)}` };
          }
          ctx.audit.write({ kind: "searxng", ms: Date.now() - t0, results: hits.length });
          if (!hits.length) return { status: "done", text: "Aucun résultat." };
          const list = hits.map((x, i) => `${i + 1}. ${x.title} — ${x.source ?? "?"} — ${x.url}${x.summary ? ` — ${x.summary}` : ""}`).join("\n");
          return { status: "done", text: `Résultats :\n${list}` };
        },
      }]);
      ctx.items.status(t(`sur ${cfg.url}`, `on ${cfg.url}`));
    },
  });
}

export default createSearxngPlugin();
