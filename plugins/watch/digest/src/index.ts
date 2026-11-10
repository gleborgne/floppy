// Plugin Veille : des centres d'intérêt (flux RSS, recherches web), un digest Markdown par jour, des préférences
// affinées à la voix (« le 3 ne m'intéresse pas », « plus jamais de crypto »).
//
// Rôles :
// - La tâche « daily » (contrat task) : le noyau la lance (Planificateur à l'heure, ou « fais ma veille »),
//   et annonce le résultat. Ce plugin ne connaît ni l'horloge ni les corps.
// - Deux slots, choisis dans la rubrique Veille : watch.triage (service completion, ex. Claude Sonnet) et
//   watch.search (service search : SearXNG, Recherche Claude… ou aucun = flux RSS seulement).
//   Ils sont empruntés (ctx.borrow) le temps du passage : rien ne tourne entre deux veilles.
// - Pré-tri en code avant le modèle (déjà vus, trop vieux, mots bannis, doublons, plafond) : voir presort.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { definePlugin, errorText, fold, T, TextError, tr, type ItemInfo, type OpResult, type Text, type ToolDef, type PluginDef } from "@floppy/core";
import type { BriefRequest, BriefSection, CompletionService, SearchService } from "@floppy/contracts";
import { PrefsStore } from "./prefs.ts";
import { fetchFeed } from "./feeds.ts";
import { WatchDb, type DigestArticle } from "./store.ts";
import { runPipeline, digestMarkdown, type Interest, type PipelineConfig } from "./pipeline.ts";

/** Texte construit pour chaque langue (fr, en). */
const both = (f: (lang: "fr" | "en") => string): Text => T(f("fr"), f("en"));

const InteretCfg = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  feeds: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
  max: z.number().int().min(1).max(30).default(8),
});

const Config = z.object({
  /** Centres d'intérêt de départ (floppy.yml). Ceux ajoutés dans les réglages sont gardés à part. */
  interests: z.record(z.string(), InteretCfg).default({}),
  threshold: z.number().min(0).max(10).default(6),
  batch: z.number().int().min(5).max(50).default(20),
  maxToModel: z.number().int().min(5).max(200).default(60),
  windowDays: z.number().int().min(1).max(30).default(2),
});
type Config = z.infer<typeof Config>;

export interface WatchOptions {
  /** Pour les tests : faux fetch des flux. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const KIND = {
  id: "interest",
  label: T("Centre d'intérêt", "Interest"),
  fields: [
    { key: "name", label: T("Nom", "Name"), type: "text" as const, required: true, placeholder: T("IA locale", "Local AI") },
    { key: "description", label: T("Ce qui t'intéresse", "What you care about"), type: "textarea" as const, hint: T("Dit au modèle qui trie : « les nouveaux modèles open weights, llama.cpp, pas le business ».", "Told to the sorting model: “new open-weights models, llama.cpp, not the business side”.") },
    { key: "feeds", label: T("Flux RSS ou Atom", "RSS or Atom feeds"), type: "list" as const,
      placeholder: T("https://simonwillison.net/atom/everything/\nhttps://www.reddit.com/r/LocalLLaMA/top/.rss?t=day", "https://…/feed.xml"),
      hint: T("Une adresse par ligne. « Essayer » lit chaque flux et dit combien d'articles il donne.", "One address per line. “Try” reads each feed and tells how many articles it gives.") },
    { key: "queries", label: T("Recherches web", "Web searches"), type: "list" as const,
      placeholder: T("llama.cpp nouvelle version\nmodèle open weights", "llama.cpp new release\nopen weights model"),
      hint: T("Une recherche par ligne, faite par le moteur de recherche choisi dans cette rubrique. Sans flux ni recherche, le nom sert de recherche.", "One search per line, run by the search engine chosen in this section. With no feed and no search, the name is used as the search.") },
    { key: "max", label: T("Articles au plus par veille", "Max articles per run"), type: "number" as const, default: 8, min: 1, max: 30, advanced: true },
  ],
};

function cleanInterest(v: Record<string, unknown>): Omit<Interest, "id"> {
  const list = (x: unknown) => (Array.isArray(x) ? x : typeof x === "string" ? x.split(/\n|,/) : []).map((s) => String(s).trim()).filter(Boolean);
  const max = Number(v.max);
  return {
    name: String(v.name ?? "").trim(), description: String(v.description ?? "").trim(),
    feeds: list(v.feeds), queries: list(v.queries), max: Number.isFinite(max) && max >= 1 ? Math.min(30, Math.round(max)) : 8,
  };
}

const strList = (x: unknown): string[] => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []).map((v) => String(v).trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Valeurs d'un centre d'intérêt après `edit` à la voix : ajoute, retire, remplace la description ou le nom. */
function modified(cur: Omit<Interest, "id">, a: Record<string, unknown>): Record<string, unknown> {
  const outFlux = strList(a.remove_feeds).map((x) => x.toLowerCase());
  const outReq = strList(a.remove_queries);
  const feeds = cur.feeds.filter((u) => !outFlux.some((x) => u.toLowerCase().includes(x)));
  const queries = cur.queries.filter((q) => !outReq.some((x) => same(q, x)));
  for (const u of strList(a.feeds)) if (!feeds.some((x) => same(x, u))) feeds.push(u);
  for (const q of strList(a.queries)) if (!queries.some((x) => same(x, q))) queries.push(q);
  const name = strList(a.new_name)[0] ?? cur.name;
  const description = typeof a.description === "string" && a.description.trim() ? a.description.trim() : cur.description;
  return { name, description, feeds, queries, max: cur.max };
}

/** Ce que change `edit`, pour la demande d'accord. */
function changes(a: Record<string, unknown>, l: "fr" | "en"): string {
  const en = l === "en";
  const list = (k: string, fr: string, eng: string) => (strList(a[k]).length ? `${en ? eng : fr}${en ? ": " : " : "}${strList(a[k]).join(", ")}` : "");
  const parts = [
    strList(a.new_name)[0] ? (en ? `rename to “${strList(a.new_name)[0]}”` : `renommer en « ${strList(a.new_name)[0]} »`) : "",
    typeof a.description === "string" && a.description.trim() ? (en ? "new description" : "nouvelle description") : "",
    list("queries", "+ recherches", "+ searches"), list("feeds", "+ flux", "+ feeds"),
    list("remove_queries", "− recherches", "− searches"), list("remove_feeds", "− flux", "− feeds"),
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(en ? "; " : " ; ")})` : "";
}

/** Minuscules sans accents, coupé en mots. */
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/** Articles qui parlent le plus des mots demandés (titre, résumé, source) : les meilleurs ex aequo, ou aucun. */
export function findArticles(list: DigestArticle[], query: string): DigestArticle[] {
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  const scored = list.map((a) => {
    const title = new Set(words(a.title));
    const reste = new Set(words(`${a.summary} ${a.source}`));
    // Un mot du titre compte double : « TTS » dans le titre désigne mieux l'article que dans un résumé.
    return { a, score: q.reduce((n, w) => n + (title.has(w) ? 2 : reste.has(w) ? 1 : 0), 0) };
  });
  const best = Math.max(...scored.map((s) => s.score));
  return best > 0 ? scored.filter((s) => s.score === best).map((s) => s.a) : [];
}

export function createWatchPlugin(opts: WatchOptions = {}): PluginDef<Config> {
  return definePlugin<Config>({
    manifest: {
      id: "watch",
      version: "0.1.0",
      licence: "MIT",
      description: "Veille : flux RSS et recherches web sur tes centres d'intérêt, triés par un modèle, en digest Markdown chaque jour.",
      // brief : les meilleurs articles du digest du jour, rubrique du point du matin.
      provides: ["task", "brief"],
      optional: ["documents"],
      permissions: { net: ["*"] },
      sections: [{ id: "watch", label: T("Veille", "News watch"), description: T("Tes centres d'intérêt, le cerveau qui trie, le moteur de recherche. Affine à la voix : « le 3 ne m'intéresse pas ».", "Your interests, the sorting brain, the search engine. Fine-tune by voice: “number 3 doesn't interest me”.") }],
      slots: [
        { id: "watch.triage", service: "completion", section: "watch", label: T("Cerveau du tri", "Sorting brain"), description: T("Le modèle qui note et résume les articles. Il tourne seulement pendant la veille.", "The model that scores and summarizes articles. It only runs during the news watch.") },
        { id: "watch.search", service: "search", section: "watch", label: T("Moteur de recherche", "Search engine"), none: T("Aucun (flux RSS seulement)", "None (RSS only)") },
      ],
      tasks: [{
        id: "daily", label: T("Veille du jour", "Daily news watch"),
        description: T("Lit les flux et fait les recherches, trie les nouveaux articles et prépare le digest.", "Reads feeds, runs searches, sorts new articles and writes the digest."),
        schedule: { at: "07:30" }, timeout_s: 900,
        // Les réglages de la Veille (centres d'intérêt, cerveau du tri, moteur) sont sous sa tâche, pas dans le menu.
        configure: "watch",
      }],
      addable: { section: "watch", label: T("Veille", "News watch"), description: T("Un digest par jour sur tes centres d'intérêt.", "A daily digest on your interests."), single: true },
    },
    config: Config,
    apply(ctx, cfg) {
      const now = opts.now ?? (() => new Date());
      /** Langue de l'assistant : ce que Floppy dit ou écrit (digest, annonce). */
      const lang = () => ctx.assistant.language;
      const say = (t: Text) => tr(t, lang());
      const dir = join(ctx.home, "watch");
      mkdirSync(dir, { recursive: true });
      const prefs = new PrefsStore(join(dir, "preferences.json"));
      const db = new WatchDb(join(dir, "watch.db"));
      ctx.effect(() => db.close());
      const store = ctx.items.store();

      const base: Record<string, Record<string, unknown>> = {};
      for (const [id, v] of Object.entries(cfg.interests)) base[id] = v as unknown as Record<string, unknown>;
      const all = (): (Interest & { enabled: boolean })[] => Object.entries(store.merge(base))
        .map(([id, v]) => ({ id, ...cleanInterest(v as Record<string, unknown>), enabled: store.isEnabled(id) }));
      /** Une source (flux ou recherche) peut être coupée sans être supprimée : case décochée dans le détail. */
      const srcId = (kind: "f" | "q", v: string) => `${kind}:${v}`;
      const srcOn = (id: string, child: string) => store.child(id, child) !== false;
      const active = () => all().filter((i) => i.enabled).map((i) => ({
        ...i, feeds: i.feeds.filter((u) => srcOn(i.id, srcId("f", u))), queries: i.queries.filter((q) => srcOn(i.id, srcId("q", q))),
      }));
      const findInterest = (q: string | undefined) => {
        if (!q) return undefined;
        const n = q.toLowerCase().trim();
        return all().find((i) => i.id === n || i.name.toLowerCase() === n) ?? all().find((i) => i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase()));
      };

      // ---------------------------------------------------------------- centres d'intérêt (rubrique Veille)
      const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
      const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
      const info = (i: Interest & { enabled: boolean }): ItemInfo => {
        const p = prefs.of(i.id);
        const noEngine = ctx.settings.value("slot.watch.search") === "@none";
        const fluxOn = i.feeds.filter((u) => srcOn(i.id, srcId("f", u))).length;
        const reqOn = i.queries.filter((q) => srcOn(i.id, srcId("q", q))).length;
        const none = !fluxOn && !(reqOn && !noEngine);
        const summary = (l: "fr" | "en") => [
          i.feeds.length ? (l === "en" ? plural(fluxOn, "feed", "feeds") : plural(fluxOn, "flux", "flux")) : "",
          i.queries.length ? (l === "en" ? plural(reqOn, "search", "searches") : plural(reqOn, "recherche", "recherches")) : "",
        ].filter(Boolean).join(" · ");
        const avis = (l: "fr" | "en") => (l === "en" ? [
          p.likes.length ? `you like ${p.likes.join(", ")}` : "",
          p.avoids.length ? `you avoid ${p.avoids.join(", ")}` : "",
          p.banned.length ? `never: ${p.banned.join(", ")}` : "",
          p.examples.length ? plural(p.examples.length, "rated article", "rated articles") : "",
        ] : [
          p.likes.length ? `tu aimes ${p.likes.join(", ")}` : "",
          p.avoids.length ? `tu évites ${p.avoids.join(", ")}` : "",
          p.banned.length ? `jamais : ${p.banned.join(", ")}` : "",
          p.examples.length ? plural(p.examples.length, "article noté", "articles notés") : "",
        ]).filter(Boolean).join(" · ");
        const children = [
          ...i.feeds.map((u) => ({ id: srcId("f", u), label: short(u), enabled: srcOn(i.id, srcId("f", u)), tag: T("flux", "feed") })),
          ...i.queries.map((q) => ({
            id: srcId("q", q), label: q, enabled: srcOn(i.id, srcId("q", q)),
            ...(noEngine ? { tag: T("aucun moteur choisi", "no search engine"), tone: "warn" as const } : { tag: T("recherche", "search") }),
          })),
        ];
        return {
          id: i.id, label: i.name, kind: "interest", enabled: i.enabled,
          detail: both((l) => [
            i.description || (l === "en" ? "Add a description: the model sorts better when it knows what you are looking for." : "Ajoute une description : le modèle trie mieux quand il sait ce que tu cherches."),
            avis(l) ? (l === "en" ? `Your feedback: ${avis(l)}.` : `Tes avis : ${avis(l)}.`) : "",
          ].filter(Boolean).join("\n")),
          status: !i.enabled ? "off" : none ? "warn" : "ok",
          statusText: !i.enabled ? T("mis de côté : pas dans la veille", "set aside")
            : none ? T("aucune source active : ajoute un flux", "no active source: add a feed")
            : T(`${summary("fr")} · ${i.max} articles au plus`, `${summary("en")} · max ${i.max} articles`),
          values: { name: i.name, description: i.description, feeds: i.feeds, queries: i.queries, max: i.max },
          editable: true, removable: true, toggleable: true,
          children, childrenLabel: T("Sources", "Sources"),
        };
      };
      const check = (v: Omit<Interest, "id">): Text | undefined => {
        if (!v.name) return T("Il faut un nom.", "A name is required.");
        const bad = v.feeds.find((u) => !/^https?:\/\//i.test(u));
        if (bad) return T(`Adresse de flux invalide : ${bad}`, `Invalid feed address: ${bad}`);
        return undefined;
      };
      /** Jamais de centre d'intérêt vide : sans flux ni recherche, le nom devient la recherche web. */
      const sourced = (v: Omit<Interest, "id">): { v: Omit<Interest, "id">; note: Text } => {
        if (v.feeds.length || v.queries.length || !v.name) return { v, note: "" };
        const noEngine = ctx.settings.value("slot.watch.search") === "@none";
        return {
          v: { ...v, queries: [v.name] },
          note: noEngine
            ? T(` Pas de source donnée : je chercherai « ${v.name} » sur le web, mais aucun moteur de recherche n'est choisi (Réglages, rubrique Veille).`, ` No source given: I will search the web for “${v.name}”, but no search engine is chosen (Settings, News watch section).`)
            : T(` Pas de source donnée : je cherche « ${v.name} » sur le web.`, ` No source given: I search the web for “${v.name}”.`),
        };
      };
      const add = (values: Record<string, unknown>): OpResult => {
        const { v, note } = sourced(cleanInterest(values));
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        const id = store.add("interest", v as unknown as Record<string, unknown>, v.name, Object.keys(base));
        ctx.items.changed();
        return { ok: true, id, text: T(`« ${v.name} » ajouté à la veille.${tr(note, "fr")}`, `“${v.name}” added to the news watch.${tr(note, "en")}`) };
      };
      const update = (id: string, values: Record<string, unknown>): OpResult => {
        const cur = all().find((i) => i.id === id);
        if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
        const { v, note } = sourced(cleanInterest({ ...cur, ...values }));
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        store.update(id, v as unknown as Record<string, unknown>);
        ctx.items.changed();
        return { ok: true, id, text: T(`« ${v.name} » modifié.${tr(note, "fr")}`, `“${v.name}” updated.${tr(note, "en")}`) };
      };
      const remove = (id: string): OpResult => {
        const cur = all().find((i) => i.id === id);
        if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
        store.remove(id);
        ctx.items.changed();
        return { ok: true, text: T(`« ${cur.name} » retiré de la veille.`, `“${cur.name}” removed from the news watch.`) };
      };
      ctx.items.declare({
        id: "watch-interests", section: "watch", order: 10,
        label: T("Centres d'intérêt", "Interests"),
        description: T("Chaque sujet a ses flux et ses recherches. Le modèle note les nouveaux articles d'après ta description et tes avis.", "Each topic has its feeds and searches. The model scores new articles from your description and your feedback."),
        addLabel: T("Ajouter un centre d'intérêt", "Add an interest"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values) => (kind === "interest" ? add(values) : { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) }),
        update: async (id, values) => update(id, values),
        remove: async (id) => remove(id),
        setChild: async (id, child, on) => {
          const cur = all().find((i) => i.id === id);
          if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
          store.setChild(id, child, on);
          ctx.items.changed();
          const what = child.slice(2);
          return { ok: true, text: on ? T(`« ${what} » remis dans « ${cur.name} ».`, `“${what}” back in “${cur.name}”.`) : T(`« ${what} » coupé pour « ${cur.name} » (gardé dans la liste).`, `“${what}” turned off for “${cur.name}” (kept in the list).`) };
        },
        // « Essayer » dans le formulaire : lit chaque flux et dit ce qu'il donne.
        test: async (_kind, values) => {
          const v = cleanInterest(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          if (!v.feeds.length) {
            return { ok: true, text: v.queries.length
              ? T("Pas de flux à lire. Les recherches seront faites par le moteur choisi dans la rubrique.", "No feed to read. Searches will be run by the engine chosen in this section.")
              : T("Pas de flux ni de recherche : le nom servira de recherche web.", "No feed and no search: the name will be used as the web search.") };
          }
          const results = await Promise.all(v.feeds.map(async (u) => {
            try {
              const items = await fetchFeed(u, { fetch: opts.fetch ?? ctx.fetch, timeoutMs: 10_000 });
              const d = items[0]?.date ? new Date(items[0].date) : undefined;
              const src = items[0]?.source ?? "";
              const detail = T(`${items.length} articles · ${src}${d ? ` · dernier le ${d.toLocaleDateString("fr-FR")}` : ""}`, `${items.length} articles · ${src}${d ? ` · latest on ${d.toLocaleDateString("en-GB")}` : ""}`);
              return { ok: true, child: { id: srcId("f", u), label: short(u), detail, enabled: true, tag: T("ok", "ok") } };
            } catch (e) {
              return { ok: false, child: { id: srcId("f", u), label: short(u), detail: errorText(e), enabled: false, tag: T("erreur", "error"), tone: "danger" as const } };
            }
          }));
          const fails = results.filter((r) => !r.ok).length;
          return {
            ok: fails === 0,
            text: fails
              ? T(`${plural(fails, "flux ne répond pas", "flux ne répondent pas")} sur ${v.feeds.length}.`, `${fails} of ${v.feeds.length} ${v.feeds.length > 1 ? "feeds" : "feed"} not answering.`)
              : T(`Les ${plural(v.feeds.length, "flux répond", "flux répondent")}.`, v.feeds.length > 1 ? `All ${v.feeds.length} feeds answer.` : "The feed answers."),
            children: results.map((r) => r.child),
          };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((i) => i.id === id);
          if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
          store.setEnabled(id, on);
          ctx.items.changed();
          return { ok: true, text: on ? T(`« ${cur.name} » remis dans la veille.`, `“${cur.name}” back in the news watch.`) : T(`« ${cur.name} » mis de côté (rien n'est supprimé).`, `“${cur.name}” set aside (nothing deleted).`) };
        },
      });

      // ---------------------------------------------------------------- la tâche
      const pcfg: PipelineConfig = { threshold: cfg.threshold, batch: cfg.batch, maxToModel: cfg.maxToModel, windowDays: cfg.windowDays };
      ctx.provide("task", {
        async run(taskId, input) {
          if (taskId !== "daily") throw new TextError(T(`tâche inconnue : ${taskId}`, `unknown task: ${taskId}`));
          const interests = active();
          if (!interests.length) return { summary: say(T("La veille n'a aucun centre d'intérêt : ajoutes-en un dans Réglages, rubrique Veille.", "The news watch has no interest: add one in Settings, News watch section.")), announce: "normal" };
          const tri = await ctx.borrow<CompletionService>("watch.triage");
          if (!tri) throw new TextError(T("aucun cerveau choisi pour le tri (Réglages, rubrique Veille)", "no brain chosen for sorting (Settings, News watch section)"));
          const rech = interests.some((i) => i.queries.length) ? await ctx.borrow<SearchService>("watch.search") : undefined;
          try {
            const date = now();
            const r = await runPipeline({
              interests, prefs: (i) => prefs.merged(i), alreadySeen: (u) => db.seen(u),
              completion: tri.service, ...(rech ? { search: rech.service } : {}), fetch: opts.fetch ?? ctx.fetch,
              now: date, ...(input.lastRun ? { lastRun: input.lastRun } : {}),
              cfg: pcfg, signal: input.signal, log: (level, m) => ctx.log(level, m), lang: lang(),
            });
            db.markSeen(r.seen, date);
            if (!r.stats.kept) {
              const down = r.stats.errors.length && !r.stats.collected;
              return { summary: say(T(
                `Rien de nouveau d'intéressant dans ta veille aujourd'hui.${down ? ` Les sources n'ont pas répondu : ${r.stats.errors.join(" ; ")}.` : ""}`,
                `Nothing new and interesting in your news watch today.${down ? ` The sources did not answer: ${r.stats.errors.join("; ")}.` : ""}`,
              )), announce: "normal" };
            }
            const doc = digestMarkdown(r, date, "", lang());
            const docs = ctx.maybe("documents");
            const ref = docs ? await docs.save({ title: doc.title, markdown: doc.markdown, source: "watch", tags: ["watch"] }) : undefined;
            db.setDigest(doc.articles.map((a) => ({ ...a, doc: ref?.id ?? "" })));
            const sujets = r.sections.length;
            const n = r.stats.kept;
            const summary = say(T(
              `Ta veille est prête : ${n} article${n > 1 ? "s" : ""} sur ${sujets} sujet${sujets > 1 ? "s" : ""}.`,
              `Your news watch is ready: ${n} article${n > 1 ? "s" : ""} on ${sujets} topic${sujets > 1 ? "s" : ""}.`,
            ));
            const sep = lang() === "en" ? "; " : " ; ";
            return ref ? { summary: summary, document: ref, announce: "normal" } : { summary: `${summary} ${doc.articles.slice(0, 3).map((a) => a.title).join(sep)}.`, announce: "normal" };
          } finally {
            tri.release();
            rech?.release();
          }
        },
      });

      // ---------------------------------------------------------------- rubrique du point du matin
      /** Le digest fait depuis minuit (ou depuis le dernier point) : ses premiers articles, numérotés comme le digest. */
      const briefSection = async (req: BriefRequest): Promise<BriefSection> => {
        const en = req.lang === "en";
        const title = en ? "News watch" : "Veille";
        const ref = (await ctx.maybe("documents")?.list({ tag: "watch", max: 1 }))?.[0];
        const midnight = new Date(req.now); midnight.setHours(0, 0, 0, 0);
        const fresh = ref && Date.parse(ref.date) >= Math.min(+midnight, req.since ? +req.since : +midnight);
        const list = db.digest();
        if (!fresh || !list.length) return { title, markdown: en ? "No new digest today." : "Pas de nouveau digest aujourd'hui.", empty: true };
        const top = list.slice(0, 5).map((a) => `- ${a.number}. ${a.title} (${a.source})`);
        const more = list.length > 5 ? `\n${en ? `…${list.length - 5} more in the digest.` : `…${list.length - 5} autres dans le digest.`}` : "";
        return { title, markdown: `${top.join("\n")}${more}` };
      };
      ctx.offer("brief", {
        items: () => [{ id: "watch", label: T("Veille du jour", "Today's news watch") }],
        start(f) { f.provide("brief", { collect: briefSection }); },
      });

      // ---------------------------------------------------------------- outils pour le cerveau
      const tools: ToolDef[] = [
        {
          name: "watch_feedback",
          description: "Retient un avis de l'utilisateur sur sa veille, pour trier mieux les jours suivants. « le 3 ne m'intéresse pas » → article: 3, feedback: less. « plus d'articles sur llama.cpp » → topic, feedback: more. « plus jamais de crypto » → topic: crypto, feedback: never (retiré avant même le tri). « en fait la crypto ça va » → topic, feedback: forget. interest : centre d'intérêt concerné (facultatif). Appelle-le tout de suite, sans demander de confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              article: { type: "integer", description: "Numéro de l'article dans le dernier digest." },
              topic: { type: "string", description: "Sujet ou mot (« crypto », « levées de fonds »)." },
              feedback: { type: "string", enum: ["more", "less", "never", "forget"] },
              interest: { type: "string", description: "Centre d'intérêt concerné, si l'utilisateur le dit. Sinon : celui de l'article, ou tous." },
            },
            required: ["feedback"],
          },
          // Préférence interne, sans effet hors de la veille, annulable par « oublier » : pas d'accord demandé.
          level: "read",
          handler: async (a) => {
            const avis = String(a.feedback ?? "");
            const art = a.article !== undefined ? db.article(Number(a.article)) : undefined;
            if (a.article !== undefined && !art) return { status: "failed", text: T(`Il n'y a pas d'article ${String(a.article)} dans le dernier digest.`, `There is no article ${String(a.article)} in the latest digest.`) };
            const it = findInterest(a.interest ? String(a.interest) : undefined)?.id ?? art?.interest;
            const sujet = a.topic ? String(a.topic).trim() : "";
            const nom = it ? all().find((i) => i.id === it)?.name ?? it : "";
            const where = it ? T(` pour « ${nom} »`, ` for “${nom}”`) : T(" pour toute la veille", " for the whole news watch");
            const w = (l: "fr" | "en") => tr(where, l);
            const done: Text[] = [];
            if (art && (avis === "more" || avis === "less")) {
              prefs.addExample(art.title, avis === "more" ? "+" : "-", art.interest);
              done.push(avis === "more" ? T(`noté que tu as aimé « ${art.title} »`, `noted that you liked “${art.title}”`) : T(`noté que tu n'as pas aimé « ${art.title} »`, `noted that you didn't like “${art.title}”`));
            }
            if (art && avis === "never" && !sujet) {
              prefs.addExample(art.title, "-", art.interest);
              done.push(T(`noté que tu n'as pas aimé « ${art.title} » (dis-moi le sujet à bannir pour l'écarter toujours)`, `noted that you didn't like “${art.title}” (tell me the topic to ban to always leave it out)`));
            }
            if (sujet) {
              if (avis === "forget") {
                done.push(prefs.forget(sujet, it)
                  ? both((l) => (l === "en" ? `forgot “${sujet}”` : `oublié « ${sujet} »`) + w(l))
                  : both((l) => (l === "en" ? `“${sujet}” was not in your preferences` : `« ${sujet} » n'était pas dans tes préférences`) + w(l)));
              } else {
                const list = avis === "more" ? "likes" : avis === "less" ? "avoids" : "banned";
                prefs.addTopic(list, sujet, it);
                done.push(both((l) => (avis === "more" ? (l === "en" ? `more “${sujet}”` : `plus de « ${sujet} »`)
                  : avis === "less" ? (l === "en" ? `less “${sujet}”` : `moins de « ${sujet} »`)
                  : (l === "en" ? `never again “${sujet}”` : `plus jamais « ${sujet} »`)) + w(l)));
              }
            }
            if (!done.length) return { status: "failed", text: T("Dis-moi un numéro d'article ou un sujet.", "Tell me an article number or a topic.") };
            ctx.items.changed();
            return { status: "done", text: T(
              `C'est retenu : ${done.map((d) => tr(d, "fr")).join(" ; ")}. Ce sera pris en compte à la prochaine veille.`,
              `Got it: ${done.map((d) => tr(d, "en")).join("; ")}. It will count from the next news watch.`,
            ) };
          },
        },
        {
          name: "watch_interests",
          description: "Liste les centres d'intérêt de la veille (sources, préférences), et le dernier digest.",
          inputSchema: { type: "object", properties: {} },
          level: "read",
          handler: async () => {
            const l = all();
            if (!l.length) return { status: "done", text: T("La veille n'a aucun centre d'intérêt.", "The news watch has no interest.") };
            const d = db.digest();
            return { status: "done", text: both((lg) => {
              const en = lg === "en";
              const lines = l.map((i) => {
                const p = prefs.merged(i.id);
                return en
                  ? `- ${i.name}${i.enabled ? "" : " (off)"}: ${i.feeds.length} feeds, searches: ${i.queries.join(", ") || "none"}${p.likes.length ? `; likes: ${p.likes.join(", ")}` : ""}${p.avoids.length ? `; avoids: ${p.avoids.join(", ")}` : ""}${p.banned.length ? `; banned: ${p.banned.join(", ")}` : ""}`
                  : `- ${i.name}${i.enabled ? "" : " (désactivé)"} : ${i.feeds.length} flux, recherches : ${i.queries.join(", ") || "aucune"}${p.likes.length ? ` ; aime : ${p.likes.join(", ")}` : ""}${p.avoids.length ? ` ; évite : ${p.avoids.join(", ")}` : ""}${p.banned.length ? ` ; banned : ${p.banned.join(", ")}` : ""}`;
              });
              const titles = d.map((x) => `${x.number}. ${x.title}`).join("\n");
              return en
                ? `${lines.join("\n")}\nLatest digest: ${d.length ? `${d.length} articles (details: watch_article)\n${titles}` : "none"}.`
                : `${lines.join("\n")}\nDernier digest : ${d.length ? `${d.length} articles (détails : watch_article)\n${titles}` : "aucun"}.`;
            }) };
          },
        },
        {
          name: "watch_article",
          description: "Articles du dernier digest. Avec article (numéro) ou search (mots du sujet ou du titre : « TTS », « Gemma ») : détails de l'article (titre, source, résumé, adresse), pour en parler ou l'ouvrir avec open_url. Sans rien : la liste numérotée des titles. Appelle-le dès que l'utilisateur parle d'un article de sa veille, sans lui demander le numéro.",
          inputSchema: {
            type: "object",
            properties: {
              article: { type: "integer", description: "Numéro de l'article dans le dernier digest." },
              search: { type: "string", description: "Mots qui désignent l'article (sujet, outil, titre), si l'utilisateur ne donne pas de numéro." },
            },
          },
          level: "read",
          handler: async (a) => {
            const details = (art: DigestArticle) => T(`${art.number}. ${art.title} (${art.source})\n${art.summary}\nAdresse : ${art.url}`, `${art.number}. ${art.title} (${art.source})\n${art.summary}\nAddress: ${art.url}`);
            if (a.article !== undefined && a.article !== null) {
              const art = db.article(Number(a.article));
              if (!art) return { status: "failed", text: T(`Pas d'article ${String(a.article)} dans le dernier digest.`, `No article ${String(a.article)} in the latest digest.`) };
              return { status: "done", text: details(art) };
            }
            const d = db.digest();
            if (!d.length) return { status: "failed", text: T("Il n'y a pas encore de digest.", "There is no digest yet.") };
            const q = typeof a.search === "string" ? a.search.trim() : "";
            const found = q ? findArticles(d, q) : [];
            if (found.length === 1) return { status: "done", text: details(found[0]!) };
            const list = (found.length ? found : d).map((x) => `${x.number}. ${x.title}`).join("\n");
            const head = !q ? T("Articles du dernier digest :", "Articles in the latest digest:")
              : found.length ? T(`Plusieurs articles parlent de « ${q} » :`, `Several articles match “${q}”:`)
              : T(`Aucun titre ne parle de « ${q} ». Articles du dernier digest :`, `No title matches “${q}”. Articles in the latest digest:`);
            return { status: "done", text: T(`${tr(head, "fr")}\n${list}`, `${tr(head, "en")}\n${list}`) };
          },
        },
        {
          name: "watch_edit_interest",
          description: "Ajoute, modifie ou retire un centre d'intérêt de la veille, quand l'utilisateur le demande. « ajoute un centre d'intérêt sur l'IA locale » → action: add, name: « IA locale » (donne aussi description et queries si tu sais ; sans source, le nom sert de recherche web). « ajoute la recherche llama.cpp à mon IA locale » → action: edit, name, queries. « retire le flux de Reddit » → action: edit, remove_feeds. « supprime ma veille sur la Bretagne » → action: remove. new_name : nouveau nom (edit) ; feeds : adresses de flux à ajouter ; remove_queries : recherches à retirer. Le noyau demande l'accord : appelle-le directement.",
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "edit", "remove"] },
              name: { type: "string", description: "Nom du centre d'intérêt à créer, à modifier ou à retirer." },
              new_name: { type: "string", description: "edit : nouveau nom." },
              description: { type: "string", description: "Ce qui intéresse l'utilisateur, pour le modèle qui trie. edit : remplace l'ancienne." },
              feeds: { type: "array", items: { type: "string" }, description: "Adresses de flux RSS ou Atom à ajouter." },
              queries: { type: "array", items: { type: "string" }, description: "Recherches web à ajouter." },
              remove_feeds: { type: "array", items: { type: "string" }, description: "edit : flux à retirer (adresse ou morceau d'adresse)." },
              remove_queries: { type: "array", items: { type: "string" }, description: "edit : recherches à retirer." },
            },
            required: ["action", "name"],
          },
          level: "write",
          summary: (a) => {
            const nom = String(a.name ?? "");
            if (a.action === "remove") return T(`Retirer le centre d'intérêt « ${nom} »`, `Remove the interest “${nom}”`);
            if (a.action === "edit") return T(`Modifier le centre d'intérêt « ${nom} »${changes(a, "fr")}`, `Change the interest “${nom}”${changes(a, "en")}`);
            return T(`Ajouter le centre d'intérêt « ${nom} »`, `Add the interest “${nom}”`);
          },
          handler: async (a) => {
            const nom = String(a.name ?? "");
            if (a.action === "remove" || a.action === "edit") {
              const cur = findInterest(nom);
              if (!cur) return { status: "failed", text: T(`Je ne trouve pas « ${nom} ». Utilise watch_interests.`, `I can't find “${nom}”. Use watch_interests.`) };
              const r: OpResult = a.action === "remove" ? remove(cur.id) : update(cur.id, modified(cur, a));
              return { status: r.ok ? "done" : "failed", text: r.text };
            }
            const r = add({ name: nom, description: a.description ?? "", feeds: a.feeds ?? [], queries: a.queries ?? [] });
            return { status: r.ok ? "done" : "failed", text: r.text };
          },
        },
      ];
      ctx.tools.register(tools);
    },
  });
}

export default createWatchPlugin();
