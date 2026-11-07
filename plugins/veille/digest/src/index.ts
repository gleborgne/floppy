// Plugin Veille : des centres d'intérêt (flux RSS, recherches web), un digest Markdown par jour, des préférences
// affinées à la voix (« le 3 ne m'intéresse pas », « plus jamais de crypto »).
//
// Rôles :
// - La tâche « quotidienne » (contrat task) : le noyau la lance (Planificateur à l'heure, ou « fais ma veille »),
//   et annonce le résultat. Ce plugin ne connaît ni l'horloge ni les corps.
// - Deux slots, choisis dans la rubrique Veille : veille.tri (service completion, ex. Claude Sonnet) et
//   veille.recherche (service search : SearXNG, Recherche Claude… ou aucun = flux RSS seulement).
//   Ils sont empruntés (ctx.borrow) le temps du passage : rien ne tourne entre deux veilles.
// - Pré-tri en code avant le modèle (déjà vus, trop vieux, mots bannis, doublons, plafond) : voir pretri.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { definePlugin, errorText, T, TextError, tr, type CompletionService, type SearchService, type ItemInfo, type OpResult, type Text, type ToolDef, type PluginDef } from "@floppy/core";
import { PrefsStore } from "./prefs.ts";
import { fetchFeed } from "./feeds.ts";
import { VeilleDb } from "./store.ts";
import { runPipeline, digestMarkdown, type Interet, type PipelineConfig } from "./pipeline.ts";

/** Texte construit pour chaque langue (fr, en). */
const both = (f: (lang: "fr" | "en") => string): Text => T(f("fr"), f("en"));

const InteretCfg = z.object({
  nom: z.string().min(1),
  description: z.string().default(""),
  flux: z.array(z.string()).default([]),
  requetes: z.array(z.string()).default([]),
  max: z.number().int().min(1).max(30).default(8),
});

const Config = z.object({
  /** Centres d'intérêt de départ (floppy.yml). Ceux ajoutés dans les réglages sont gardés à part. */
  interets: z.record(z.string(), InteretCfg).default({}),
  seuil: z.number().min(0).max(10).default(6),
  lot: z.number().int().min(5).max(50).default(20),
  maxVersModele: z.number().int().min(5).max(200).default(60),
  fenetreJours: z.number().int().min(1).max(30).default(2),
});
type Config = z.infer<typeof Config>;

export interface VeilleOptions {
  /** Pour les tests : faux fetch des flux. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const KIND = {
  id: "interet",
  label: T("Centre d'intérêt", "Interest"),
  fields: [
    { key: "nom", label: T("Nom", "Name"), type: "text" as const, required: true, placeholder: T("IA locale", "Local AI") },
    { key: "description", label: T("Ce qui t'intéresse", "What you care about"), type: "textarea" as const, hint: T("Dit au modèle qui trie : « les nouveaux modèles open weights, llama.cpp, pas le business ».", "Told to the sorting model: “new open-weights models, llama.cpp, not the business side”.") },
    { key: "flux", label: T("Flux RSS ou Atom", "RSS or Atom feeds"), type: "list" as const,
      placeholder: T("https://simonwillison.net/atom/everything/\nhttps://www.reddit.com/r/LocalLLaMA/top/.rss?t=day", "https://…/feed.xml"),
      hint: T("Une adresse par ligne. « Essayer » lit chaque flux et dit combien d'articles il donne.", "One address per line. “Try” reads each feed and tells how many articles it gives.") },
    { key: "requetes", label: T("Recherches web", "Web searches"), type: "list" as const,
      placeholder: T("llama.cpp nouvelle version\nmodèle open weights", "llama.cpp new release\nopen weights model"),
      hint: T("Une recherche par ligne, faite par le moteur de recherche choisi dans cette rubrique. Sans flux ni recherche, le nom sert de recherche.", "One search per line, run by the search engine chosen in this section. With no feed and no search, the name is used as the search.") },
    { key: "max", label: T("Articles au plus par veille", "Max articles per run"), type: "number" as const, default: 8, min: 1, max: 30, advanced: true },
  ],
};

function cleanInteret(v: Record<string, unknown>): Omit<Interet, "id"> {
  const list = (x: unknown) => (Array.isArray(x) ? x : typeof x === "string" ? x.split(/\n|,/) : []).map((s) => String(s).trim()).filter(Boolean);
  const max = Number(v.max);
  return {
    nom: String(v.nom ?? "").trim(), description: String(v.description ?? "").trim(),
    flux: list(v.flux), requetes: list(v.requetes), max: Number.isFinite(max) && max >= 1 ? Math.min(30, Math.round(max)) : 8,
  };
}

const strList = (x: unknown): string[] => (Array.isArray(x) ? x : typeof x === "string" ? [x] : []).map((v) => String(v).trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Valeurs d'un centre d'intérêt après « modifier » à la voix : ajoute, retire, remplace la description ou le nom. */
function modified(cur: Omit<Interet, "id">, a: Record<string, unknown>): Record<string, unknown> {
  const outFlux = strList(a.retirer_flux).map((x) => x.toLowerCase());
  const outReq = strList(a.retirer_requetes);
  const flux = cur.flux.filter((u) => !outFlux.some((x) => u.toLowerCase().includes(x)));
  const requetes = cur.requetes.filter((q) => !outReq.some((x) => same(q, x)));
  for (const u of strList(a.flux)) if (!flux.some((x) => same(x, u))) flux.push(u);
  for (const q of strList(a.requetes)) if (!requetes.some((x) => same(x, q))) requetes.push(q);
  const nom = strList(a.nouveau_nom)[0] ?? cur.nom;
  const description = typeof a.description === "string" && a.description.trim() ? a.description.trim() : cur.description;
  return { nom, description, flux, requetes, max: cur.max };
}

/** Ce que change « modifier », pour la demande d'accord. */
function changes(a: Record<string, unknown>, l: "fr" | "en"): string {
  const en = l === "en";
  const list = (k: string, fr: string, eng: string) => (strList(a[k]).length ? `${en ? eng : fr}${en ? ": " : " : "}${strList(a[k]).join(", ")}` : "");
  const parts = [
    strList(a.nouveau_nom)[0] ? (en ? `rename to “${strList(a.nouveau_nom)[0]}”` : `renommer en « ${strList(a.nouveau_nom)[0]} »`) : "",
    typeof a.description === "string" && a.description.trim() ? (en ? "new description" : "nouvelle description") : "",
    list("requetes", "+ recherches", "+ searches"), list("flux", "+ flux", "+ feeds"),
    list("retirer_requetes", "− recherches", "− searches"), list("retirer_flux", "− flux", "− feeds"),
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(en ? "; " : " ; ")})` : "";
}

export function createVeillePlugin(opts: VeilleOptions = {}): PluginDef<Config> {
  return definePlugin<Config>({
    manifest: {
      id: "veille",
      version: "0.1.0",
      licence: "MIT",
      description: "Veille : flux RSS et recherches web sur tes centres d'intérêt, triés par un modèle, en digest Markdown chaque jour.",
      provides: ["task"],
      optional: ["documents"],
      permissions: { net: ["*"] },
      sections: [{ id: "veille", label: T("Veille", "News watch"), description: T("Tes centres d'intérêt, le cerveau qui trie, le moteur de recherche. Affine à la voix : « le 3 ne m'intéresse pas ».", "Your interests, the sorting brain, the search engine. Fine-tune by voice: “number 3 doesn't interest me”.") }],
      slots: [
        { id: "veille.tri", service: "completion", section: "veille", label: T("Cerveau du tri", "Sorting brain"), description: T("Le modèle qui note et résume les articles. Il tourne seulement pendant la veille.", "The model that scores and summarizes articles. It only runs during the news watch.") },
        { id: "veille.recherche", service: "search", section: "veille", label: T("Moteur de recherche", "Search engine"), none: T("Aucun (flux RSS seulement)", "None (RSS only)") },
      ],
      tasks: [{
        id: "quotidienne", label: T("Veille du jour", "Daily news watch"),
        description: T("Lit les flux et fait les recherches, trie les nouveaux articles et prépare le digest.", "Reads feeds, runs searches, sorts new articles and writes the digest."),
        schedule: { at: "07:30" }, timeout_s: 900,
        // Les réglages de la Veille (centres d'intérêt, cerveau du tri, moteur) sont sous sa tâche, pas dans le menu.
        configure: "veille",
      }],
      addable: { section: "veille", label: T("Veille", "News watch"), description: T("Un digest par jour sur tes centres d'intérêt.", "A daily digest on your interests."), single: true },
    },
    config: Config,
    apply(ctx, cfg) {
      const now = opts.now ?? (() => new Date());
      /** Langue de l'assistant : ce que Floppy dit ou écrit (digest, annonce). */
      const lang = () => ctx.assistant.language;
      const say = (t: Text) => tr(t, lang());
      const dir = join(ctx.home, "veille");
      mkdirSync(dir, { recursive: true });
      const prefs = new PrefsStore(join(dir, "preferences.json"));
      const db = new VeilleDb(join(dir, "veille.db"));
      ctx.effect(() => db.close());
      const store = ctx.items.store();

      const base: Record<string, Record<string, unknown>> = {};
      for (const [id, v] of Object.entries(cfg.interets)) base[id] = v as unknown as Record<string, unknown>;
      const all = (): (Interet & { enabled: boolean })[] => Object.entries(store.merge(base))
        .map(([id, v]) => ({ id, ...cleanInteret(v as Record<string, unknown>), enabled: store.isEnabled(id) }));
      /** Une source (flux ou recherche) peut être coupée sans être supprimée : case décochée dans le détail. */
      const srcId = (kind: "f" | "q", v: string) => `${kind}:${v}`;
      const srcOn = (id: string, child: string) => store.child(id, child) !== false;
      const actifs = () => all().filter((i) => i.enabled).map((i) => ({
        ...i, flux: i.flux.filter((u) => srcOn(i.id, srcId("f", u))), requetes: i.requetes.filter((q) => srcOn(i.id, srcId("q", q))),
      }));
      const findInteret = (q: string | undefined) => {
        if (!q) return undefined;
        const n = q.toLowerCase().trim();
        return all().find((i) => i.id === n || i.nom.toLowerCase() === n) ?? all().find((i) => i.nom.toLowerCase().includes(n) || n.includes(i.nom.toLowerCase()));
      };

      // ---------------------------------------------------------------- centres d'intérêt (rubrique Veille)
      const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
      const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
      const info = (i: Interet & { enabled: boolean }): ItemInfo => {
        const p = prefs.of(i.id);
        const noEngine = ctx.settings.value("slot.veille.recherche") === "@none";
        const fluxOn = i.flux.filter((u) => srcOn(i.id, srcId("f", u))).length;
        const reqOn = i.requetes.filter((q) => srcOn(i.id, srcId("q", q))).length;
        const none = !fluxOn && !(reqOn && !noEngine);
        const summary = (l: "fr" | "en") => [
          i.flux.length ? (l === "en" ? plural(fluxOn, "feed", "feeds") : plural(fluxOn, "flux", "flux")) : "",
          i.requetes.length ? (l === "en" ? plural(reqOn, "search", "searches") : plural(reqOn, "recherche", "recherches")) : "",
        ].filter(Boolean).join(" · ");
        const avis = (l: "fr" | "en") => (l === "en" ? [
          p.aime.length ? `you like ${p.aime.join(", ")}` : "",
          p.evite.length ? `you avoid ${p.evite.join(", ")}` : "",
          p.bannis.length ? `never: ${p.bannis.join(", ")}` : "",
          p.exemples.length ? plural(p.exemples.length, "rated article", "rated articles") : "",
        ] : [
          p.aime.length ? `tu aimes ${p.aime.join(", ")}` : "",
          p.evite.length ? `tu évites ${p.evite.join(", ")}` : "",
          p.bannis.length ? `jamais : ${p.bannis.join(", ")}` : "",
          p.exemples.length ? plural(p.exemples.length, "article noté", "articles notés") : "",
        ]).filter(Boolean).join(" · ");
        const children = [
          ...i.flux.map((u) => ({ id: srcId("f", u), label: short(u), enabled: srcOn(i.id, srcId("f", u)), tag: T("flux", "feed") })),
          ...i.requetes.map((q) => ({
            id: srcId("q", q), label: q, enabled: srcOn(i.id, srcId("q", q)),
            ...(noEngine ? { tag: T("aucun moteur choisi", "no search engine"), tone: "warn" as const } : { tag: T("recherche", "search") }),
          })),
        ];
        return {
          id: i.id, label: i.nom, kind: "interet", enabled: i.enabled,
          detail: both((l) => [
            i.description || (l === "en" ? "Add a description: the model sorts better when it knows what you are looking for." : "Ajoute une description : le modèle trie mieux quand il sait ce que tu cherches."),
            avis(l) ? (l === "en" ? `Your feedback: ${avis(l)}.` : `Tes avis : ${avis(l)}.`) : "",
          ].filter(Boolean).join("\n")),
          status: !i.enabled ? "off" : none ? "warn" : "ok",
          statusText: !i.enabled ? T("mis de côté : pas dans la veille", "set aside")
            : none ? T("aucune source active : ajoute un flux", "no active source: add a feed")
            : T(`${summary("fr")} · ${i.max} articles au plus`, `${summary("en")} · max ${i.max} articles`),
          values: { nom: i.nom, description: i.description, flux: i.flux, requetes: i.requetes, max: i.max },
          editable: true, removable: true, toggleable: true,
          children, childrenLabel: T("Sources", "Sources"),
        };
      };
      const check = (v: Omit<Interet, "id">): Text | undefined => {
        if (!v.nom) return T("Il faut un nom.", "A name is required.");
        const bad = v.flux.find((u) => !/^https?:\/\//i.test(u));
        if (bad) return T(`Adresse de flux invalide : ${bad}`, `Invalid feed address: ${bad}`);
        return undefined;
      };
      /** Jamais de centre d'intérêt vide : sans flux ni recherche, le nom devient la recherche web. */
      const sourced = (v: Omit<Interet, "id">): { v: Omit<Interet, "id">; note: Text } => {
        if (v.flux.length || v.requetes.length || !v.nom) return { v, note: "" };
        const noEngine = ctx.settings.value("slot.veille.recherche") === "@none";
        return {
          v: { ...v, requetes: [v.nom] },
          note: noEngine
            ? T(` Pas de source donnée : je chercherai « ${v.nom} » sur le web, mais aucun moteur de recherche n'est choisi (Réglages, rubrique Veille).`, ` No source given: I will search the web for “${v.nom}”, but no search engine is chosen (Settings, News watch section).`)
            : T(` Pas de source donnée : je cherche « ${v.nom} » sur le web.`, ` No source given: I search the web for “${v.nom}”.`),
        };
      };
      const add = (values: Record<string, unknown>): OpResult => {
        const { v, note } = sourced(cleanInteret(values));
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        const id = store.add("interet", v as unknown as Record<string, unknown>, v.nom, Object.keys(base));
        ctx.items.changed();
        return { ok: true, id, text: T(`« ${v.nom} » ajouté à la veille.${tr(note, "fr")}`, `“${v.nom}” added to the news watch.${tr(note, "en")}`) };
      };
      const update = (id: string, values: Record<string, unknown>): OpResult => {
        const cur = all().find((i) => i.id === id);
        if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
        const { v, note } = sourced(cleanInteret({ ...cur, ...values }));
        const bad = check(v);
        if (bad) return { ok: false, text: bad };
        store.update(id, v as unknown as Record<string, unknown>);
        ctx.items.changed();
        return { ok: true, id, text: T(`« ${v.nom} » modifié.${tr(note, "fr")}`, `“${v.nom}” updated.${tr(note, "en")}`) };
      };
      const remove = (id: string): OpResult => {
        const cur = all().find((i) => i.id === id);
        if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
        store.remove(id);
        ctx.items.changed();
        return { ok: true, text: T(`« ${cur.nom} » retiré de la veille.`, `“${cur.nom}” removed from the news watch.`) };
      };
      ctx.items.declare({
        id: "veille-interets", section: "veille", order: 10,
        label: T("Centres d'intérêt", "Interests"),
        description: T("Chaque sujet a ses flux et ses recherches. Le modèle note les nouveaux articles d'après ta description et tes avis.", "Each topic has its feeds and searches. The model scores new articles from your description and your feedback."),
        addLabel: T("Ajouter un centre d'intérêt", "Add an interest"),
        kinds: [KIND],
        list: () => all().map(info),
        add: async (kind, values) => (kind === "interet" ? add(values) : { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) }),
        update: async (id, values) => update(id, values),
        remove: async (id) => remove(id),
        setChild: async (id, child, on) => {
          const cur = all().find((i) => i.id === id);
          if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
          store.setChild(id, child, on);
          ctx.items.changed();
          const what = child.slice(2);
          return { ok: true, text: on ? T(`« ${what} » remis dans « ${cur.nom} ».`, `“${what}” back in “${cur.nom}”.`) : T(`« ${what} » coupé pour « ${cur.nom} » (gardé dans la liste).`, `“${what}” turned off for “${cur.nom}” (kept in the list).`) };
        },
        // « Essayer » dans le formulaire : lit chaque flux et dit ce qu'il donne.
        test: async (_kind, values) => {
          const v = cleanInteret(values);
          const bad = check(v);
          if (bad) return { ok: false, text: bad };
          if (!v.flux.length) {
            return { ok: true, text: v.requetes.length
              ? T("Pas de flux à lire. Les recherches seront faites par le moteur choisi dans la rubrique.", "No feed to read. Searches will be run by the engine chosen in this section.")
              : T("Pas de flux ni de recherche : le nom servira de recherche web.", "No feed and no search: the name will be used as the web search.") };
          }
          const results = await Promise.all(v.flux.map(async (u) => {
            try {
              const items = await fetchFeed(u, { ...(opts.fetch ? { fetch: opts.fetch } : {}), timeoutMs: 10_000 });
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
              ? T(`${plural(fails, "flux ne répond pas", "flux ne répondent pas")} sur ${v.flux.length}.`, `${fails} of ${v.flux.length} ${v.flux.length > 1 ? "feeds" : "feed"} not answering.`)
              : T(`Les ${plural(v.flux.length, "flux répond", "flux répondent")}.`, v.flux.length > 1 ? `All ${v.flux.length} feeds answer.` : "The feed answers."),
            children: results.map((r) => r.child),
          };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((i) => i.id === id);
          if (!cur) return { ok: false, text: T(`Centre d'intérêt inconnu : ${id}`, `Unknown interest: ${id}`) };
          store.setEnabled(id, on);
          ctx.items.changed();
          return { ok: true, text: on ? T(`« ${cur.nom} » remis dans la veille.`, `“${cur.nom}” back in the news watch.`) : T(`« ${cur.nom} » mis de côté (rien n'est supprimé).`, `“${cur.nom}” set aside (nothing deleted).`) };
        },
      });

      // ---------------------------------------------------------------- la tâche
      const pcfg: PipelineConfig = { seuil: cfg.seuil, lot: cfg.lot, maxVersModele: cfg.maxVersModele, fenetreJours: cfg.fenetreJours };
      ctx.provide("task", {
        async run(taskId, input) {
          if (taskId !== "quotidienne") throw new TextError(T(`tâche inconnue : ${taskId}`, `unknown task: ${taskId}`));
          const interets = actifs();
          if (!interets.length) return { resume: say(T("La veille n'a aucun centre d'intérêt : ajoutes-en un dans Réglages, rubrique Veille.", "The news watch has no interest: add one in Settings, News watch section.")), annonce: "normal" };
          const tri = await ctx.borrow<CompletionService>("veille.tri");
          if (!tri) throw new TextError(T("aucun cerveau choisi pour le tri (Réglages, rubrique Veille)", "no brain chosen for sorting (Settings, News watch section)"));
          const rech = interets.some((i) => i.requetes.length) ? await ctx.borrow<SearchService>("veille.recherche") : undefined;
          try {
            const date = now();
            const r = await runPipeline({
              interets, prefs: (i) => prefs.merged(i), dejaVu: (u) => db.seen(u),
              completion: tri.service, ...(rech ? { search: rech.service } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}),
              now: date, ...(input.dernierPassage ? { dernierPassage: input.dernierPassage } : {}),
              cfg: pcfg, signal: input.signal, log: (level, m) => ctx.log(level, m), lang: lang(),
            });
            db.markSeen(r.vus, date);
            if (!r.stats.gardes) {
              const down = r.stats.erreurs.length && !r.stats.collectes;
              return { resume: say(T(
                `Rien de nouveau d'intéressant dans ta veille aujourd'hui.${down ? ` Les sources n'ont pas répondu : ${r.stats.erreurs.join(" ; ")}.` : ""}`,
                `Nothing new and interesting in your news watch today.${down ? ` The sources did not answer: ${r.stats.erreurs.join("; ")}.` : ""}`,
              )), annonce: "normal" };
            }
            const doc = digestMarkdown(r, date, "", lang());
            const docs = ctx.maybe("documents");
            const ref = docs ? await docs.save({ titre: doc.titre, markdown: doc.markdown, source: "veille", tags: ["veille"] }) : undefined;
            db.setDigest(doc.articles.map((a) => ({ ...a, doc: ref?.id ?? "" })));
            const sujets = r.sections.length;
            const n = r.stats.gardes;
            const resume = say(T(
              `Ta veille est prête : ${n} article${n > 1 ? "s" : ""} sur ${sujets} sujet${sujets > 1 ? "s" : ""}.`,
              `Your news watch is ready: ${n} article${n > 1 ? "s" : ""} on ${sujets} topic${sujets > 1 ? "s" : ""}.`,
            ));
            const sep = lang() === "en" ? "; " : " ; ";
            return ref ? { resume, document: ref, annonce: "normal" } : { resume: `${resume} ${doc.articles.slice(0, 3).map((a) => a.titre).join(sep)}.`, annonce: "normal" };
          } finally {
            tri.release();
            rech?.release();
          }
        },
      });

      // ---------------------------------------------------------------- outils pour le cerveau
      const tools: ToolDef[] = [
        {
          name: "veille_avis",
          description: "Retient un avis de l'utilisateur sur sa veille, pour trier mieux les jours suivants. « le 3 ne m'intéresse pas » → article: 3, avis: moins. « plus d'articles sur llama.cpp » → sujet, avis: plus. « plus jamais de crypto » → sujet: crypto, avis: jamais (retiré avant même le tri). « en fait la crypto ça va » → sujet, avis: oublier. Appelle-le tout de suite, sans demander de confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              article: { type: "integer", description: "Numéro de l'article dans le dernier digest." },
              sujet: { type: "string", description: "Sujet ou mot (« crypto », « levées de fonds »)." },
              avis: { type: "string", enum: ["plus", "moins", "jamais", "oublier"] },
              interet: { type: "string", description: "Centre d'intérêt concerné, si l'utilisateur le dit. Sinon : celui de l'article, ou tous." },
            },
            required: ["avis"],
          },
          // Préférence interne, sans effet hors de la veille, annulable par « oublier » : pas d'accord demandé.
          level: "read",
          handler: async (a) => {
            const avis = String(a.avis ?? "");
            const art = a.article !== undefined ? db.article(Number(a.article)) : undefined;
            if (a.article !== undefined && !art) return { status: "failed", text: T(`Il n'y a pas d'article ${String(a.article)} dans le dernier digest.`, `There is no article ${String(a.article)} in the latest digest.`) };
            const it = findInteret(a.interet ? String(a.interet) : undefined)?.id ?? art?.interet;
            const sujet = a.sujet ? String(a.sujet).trim() : "";
            const nom = it ? all().find((i) => i.id === it)?.nom ?? it : "";
            const where = it ? T(` pour « ${nom} »`, ` for “${nom}”`) : T(" pour toute la veille", " for the whole news watch");
            const w = (l: "fr" | "en") => tr(where, l);
            const done: Text[] = [];
            if (art && (avis === "plus" || avis === "moins")) {
              prefs.addExample(art.titre, avis === "plus" ? "+" : "-", art.interet);
              done.push(avis === "plus" ? T(`noté que tu as aimé « ${art.titre} »`, `noted that you liked “${art.titre}”`) : T(`noté que tu n'as pas aimé « ${art.titre} »`, `noted that you didn't like “${art.titre}”`));
            }
            if (art && avis === "jamais" && !sujet) {
              prefs.addExample(art.titre, "-", art.interet);
              done.push(T(`noté que tu n'as pas aimé « ${art.titre} » (dis-moi le sujet à bannir pour l'écarter toujours)`, `noted that you didn't like “${art.titre}” (tell me the topic to ban to always leave it out)`));
            }
            if (sujet) {
              if (avis === "oublier") {
                done.push(prefs.forget(sujet, it)
                  ? both((l) => (l === "en" ? `forgot “${sujet}”` : `oublié « ${sujet} »`) + w(l))
                  : both((l) => (l === "en" ? `“${sujet}” was not in your preferences` : `« ${sujet} » n'était pas dans tes préférences`) + w(l)));
              } else {
                const list = avis === "plus" ? "aime" : avis === "moins" ? "evite" : "bannis";
                prefs.addTopic(list, sujet, it);
                done.push(both((l) => (avis === "plus" ? (l === "en" ? `more “${sujet}”` : `plus de « ${sujet} »`)
                  : avis === "moins" ? (l === "en" ? `less “${sujet}”` : `moins de « ${sujet} »`)
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
          name: "veille_interets",
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
                  ? `- ${i.nom}${i.enabled ? "" : " (off)"}: ${i.flux.length} feeds, searches: ${i.requetes.join(", ") || "none"}${p.aime.length ? `; likes: ${p.aime.join(", ")}` : ""}${p.evite.length ? `; avoids: ${p.evite.join(", ")}` : ""}${p.bannis.length ? `; banned: ${p.bannis.join(", ")}` : ""}`
                  : `- ${i.nom}${i.enabled ? "" : " (désactivé)"} : ${i.flux.length} flux, recherches : ${i.requetes.join(", ") || "aucune"}${p.aime.length ? ` ; aime : ${p.aime.join(", ")}` : ""}${p.evite.length ? ` ; évite : ${p.evite.join(", ")}` : ""}${p.bannis.length ? ` ; bannis : ${p.bannis.join(", ")}` : ""}`;
              });
              return en
                ? `${lines.join("\n")}\nLatest digest: ${d.length ? `${d.length} articles` : "none"}.`
                : `${lines.join("\n")}\nDernier digest : ${d.length ? `${d.length} articles` : "aucun"}.`;
            }) };
          },
        },
        {
          name: "veille_article",
          description: "Détails d'un article du dernier digest par son numéro (titre, source, résumé, adresse). Pour en parler ou l'ouvrir avec ouvrir_url.",
          inputSchema: { type: "object", properties: { article: { type: "integer" } }, required: ["article"] },
          level: "read",
          handler: async (a) => {
            const art = db.article(Number(a.article));
            if (!art) return { status: "failed", text: T(`Pas d'article ${String(a.article)} dans le dernier digest.`, `No article ${String(a.article)} in the latest digest.`) };
            return { status: "done", text: T(`${art.numero}. ${art.titre} (${art.source})\n${art.resume}\nAdresse : ${art.url}`, `${art.numero}. ${art.titre} (${art.source})\n${art.resume}\nAddress: ${art.url}`) };
          },
        },
        {
          name: "veille_modifier_interet",
          description: "Ajoute, modifie ou retire un centre d'intérêt de la veille, quand l'utilisateur le demande. « ajoute un centre d'intérêt sur l'IA locale » → action: ajouter, nom: « IA locale » (donne aussi description et requetes si tu sais ; sans source, le nom sert de recherche web). « ajoute la recherche llama.cpp à mon IA locale » → action: modifier, nom, requetes. « retire le flux de Reddit » → action: modifier, retirer_flux. « supprime ma veille sur la Bretagne » → action: retirer. Le noyau demande l'accord : appelle-le directement.",
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["ajouter", "modifier", "retirer"] },
              nom: { type: "string", description: "Nom du centre d'intérêt à créer, à modifier ou à retirer." },
              nouveau_nom: { type: "string", description: "modifier : nouveau nom." },
              description: { type: "string", description: "Ce qui intéresse l'utilisateur, pour le modèle qui trie. modifier : remplace l'ancienne." },
              flux: { type: "array", items: { type: "string" }, description: "Adresses de flux RSS ou Atom à ajouter." },
              requetes: { type: "array", items: { type: "string" }, description: "Recherches web à ajouter." },
              retirer_flux: { type: "array", items: { type: "string" }, description: "modifier : flux à retirer (adresse ou morceau d'adresse)." },
              retirer_requetes: { type: "array", items: { type: "string" }, description: "modifier : recherches à retirer." },
            },
            required: ["action", "nom"],
          },
          level: "write",
          summary: (a) => {
            const nom = String(a.nom ?? "");
            if (a.action === "retirer") return T(`Retirer le centre d'intérêt « ${nom} »`, `Remove the interest “${nom}”`);
            if (a.action === "modifier") return T(`Modifier le centre d'intérêt « ${nom} »${changes(a, "fr")}`, `Change the interest “${nom}”${changes(a, "en")}`);
            return T(`Ajouter le centre d'intérêt « ${nom} »`, `Add the interest “${nom}”`);
          },
          handler: async (a) => {
            const nom = String(a.nom ?? "");
            if (a.action === "retirer" || a.action === "modifier") {
              const cur = findInteret(nom);
              if (!cur) return { status: "failed", text: T(`Je ne trouve pas « ${nom} ». Utilise veille_interets.`, `I can't find “${nom}”. Use veille_interets.`) };
              const r: OpResult = a.action === "retirer" ? remove(cur.id) : update(cur.id, modified(cur, a));
              return { status: r.ok ? "done" : "failed", text: r.text };
            }
            const r = add({ nom, description: a.description ?? "", flux: a.flux ?? [], requetes: a.requetes ?? [] });
            return { status: r.ok ? "done" : "failed", text: r.text };
          },
        },
      ];
      ctx.tools.register(tools);
    },
  });
}

export default createVeillePlugin();
