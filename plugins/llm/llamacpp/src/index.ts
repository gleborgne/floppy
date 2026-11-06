// Plugin `llm-llamacpp` : modèles locaux (llama-server, API compatible OpenAI).
// - Le plugin lui-même est léger : il tient le catalogue des modèles (fenêtre des réglages) et offre le service `llm`
//   modèle par modèle (ctx.offer). Chaque modèle choisi tourne dans un fork : llama-server vit et meurt avec lui.
// - Le noyau démarre le fork quand un slot (ex. brain.main) choisit ce modèle ET qu'un plugin actif s'en sert ;
//   il le ferme quand plus personne ne s'en sert (mode Live, autre modèle choisi…). max 1 : un seul en mémoire du GPU.
// - Si un llama-server répond déjà sur le port (reuse: true) avec le modèle voulu, il est réutilisé, jamais arrêté.
// - Un seul llama-server, PARTAGÉ par tous les forks qui veulent le même modèle : le cerveau (service llm) et le tri
//   d'une tâche (service completion, élément « cerveau » = le modèle du cerveau principal). Jamais deux modèles sur le GPU.
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePlugin, modelLibrary, type LibraryEntry, findExe, killTree, TextError, type CompletionService, type Context, type FieldDef, type ItemInfo, type ItemKind, type LlmService, type OpResult } from "@floppy/core";

import { KNOWN_MODELS } from "./known-models.ts";
import { searchHf } from "./hf.ts";

const DEFAULT_ARGS = ["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--fit", "off", "-ngl", "99", "-np", "1"];

/** Dossiers de modèles connus (LM Studio). Ceux de l'utilisateur s'ajoutent par le réglage « llm_local_dossiers ». */
export const DEFAULT_SCAN_DIRS = [join(homedir(), ".lmstudio", "models"), join(homedir(), ".cache", "lm-studio", "models")];

const ModelEntry = z.object({
  label: z.string(),
  model: z.string(),
  draft: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  /** Arguments propres au modèle (remplacent extraArgs). */
  args: z.array(z.string()).optional(),
  ctx: z.number().int().optional(),
  spec: z.enum(["none", "mtp", "draft", "ngram"]).optional(),
  placement: z.enum(["gpu", "moe", "auto"]).optional(),
  gpuMargin: z.number().int().optional(),
  ubatch: z.number().int().optional(),
  kv: z.enum(["f16", "q8_0", "q4_0"]).optional(),
  mmproj: z.string().optional(),
  reasoning: z.enum(["on", "off", "tools"]).optional(),
  thinkBudget: z.number().int().optional(),
  /** llama-server propre à ce modèle (architecture récente pas encore dans la version commune). */
  exe: z.string().optional(),
});

const Config = z.object({
  /** Programme llama-server. Absent : réglage « llm_local_programme », sinon `llama-server` trouvé dans le PATH. */
  exe: z.string().optional(),
  /** Ancienne forme : un seul modèle. */
  model: z.string().optional(),
  draft: z.string().optional(),
  alias: z.string().default("gemma4-12b-nothink"),
  /** Catalogue : { gemma: { label, model, draft?, args? }, qwen9b: {…} }. */
  models: z.record(z.string(), ModelEntry).default({}),
  /** Ancien réglage (modèle de départ) : remplacé par `slots: { brain.main: … }` dans floppy.yml. Ignoré. */
  default: z.string().optional(),
  port: z.number().int().default(8080),
  ctx: z.number().int().default(32768),
  reasoning: z.enum(["on", "off", "tools"]).default("off"),
  extraArgs: z.array(z.string()).default(DEFAULT_ARGS),
  reuse: z.boolean().default(true),
  startTimeout_s: z.number().default(240),
  /** Dossiers où chercher des .gguf (action « scan »). */
  scanDirs: z.array(z.string()).default(DEFAULT_SCAN_DIRS),
});
type Config = z.infer<typeof Config>;

async function healthy(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function modelId(base: string): Promise<string | undefined> {
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { data?: { id: string }[] };
    return j.data?.[0]?.id;
  } catch {
    return undefined;
  }
}

export type Thinking = "off" | "on" | "tools";
export type KvType = "f16" | "q8_0" | "q4_0";
export type SpecType = "none" | "mtp" | "draft" | "ngram";
const KV_TYPES: KvType[] = ["f16", "q8_0", "q4_0"];
const SPEC_TYPES: SpecType[] = ["none", "mtp", "draft", "ngram"];

/** Un modèle tel que la fenêtre le montre (formulaire). Les modèles de floppy.yml sont convertis en cette forme. */
export interface ModelValues {
  label: string;
  aliases: string[];
  model: string;
  /** Accélération : MTP (fichier MTP séparé), petit modèle brouillon, ou n-grammes (sans fichier). */
  spec: SpecType;
  draft?: string;
  /** gpu : tout sur le GPU ; moe : N couches d'experts en RAM ; auto : llama.cpp place lui-même (--fit) en gardant une marge. */
  placement: "gpu" | "moe" | "auto";
  nCpuMoe?: number;
  /** Placement auto : mémoire du GPU laissée libre (Mio), pour la voix et l'écran. */
  gpuMargin: number;
  ctx: number;
  /** Taille des paquets lus d'un coup (-ub) : plus grand = lecture des longs textes (pages, résultats d'outils) plus rapide, plus de mémoire. */
  ubatch: number;
  /** Type du cache du contexte (-ctk / -ctv). */
  kv: KvType;
  /** Vision : fichier mmproj (facultatif). */
  mmproj?: string;
  /** off : jamais ; on : toujours ; tools : pas pour la 1re réponse (rapide), oui après un outil (plus malin). */
  reasoning: Thinking;
  /** Budget de réflexion en jetons (niveau : ~256 bas, ~1024 moyen, ~4096 haut ; -1 = sans limite). */
  thinkBudget: number;
  /** Arguments avancés de llama-server (sans ceux gérés par les champs ci-dessus). */
  args: string[];
  /** llama-server propre à ce modèle (sinon celui de la config). */
  exe?: string;
}
type Entry = ModelValues & { id: string };

/** Options de llama-server gérées par des champs : retirées des arguments avancés (le champ gagne). Valeur = nombre de valeurs. */
const MANAGED: Record<string, number> = {
  "--n-cpu-moe": 1, "-ncmoe": 1, "-ub": 1, "--ubatch-size": 1, "-b": 1, "--batch-size": 1,
  "-ctk": 1, "--cache-type-k": 1, "-ctv": 1, "--cache-type-v": 1, "--fit": 1, "-fit": 1, "--fit-target": 1, "-fitt": 1,
  "-ngl": 1, "--n-gpu-layers": 1, "-mm": 1, "--mmproj": 1, "--spec-type": 1, "-md": 1, "--model-draft": 1, "-ngld": 1,
  "-c": 1, "--ctx-size": 1, "--reasoning": 1, "--reasoning-budget": 1,
};

/** Sépare les options gérées par des champs du reste des arguments. */
export function splitArgs(args: string[]): { args: string[]; found: Record<string, string> } {
  const out: string[] = [];
  const found: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const n = MANAGED[a];
    if (n === undefined) { out.push(a); continue; }
    found[a] = args[i + 1] ?? "";
    i += n;
  }
  return { args: out, found };
}

const num = (s: string | undefined): number | undefined => {
  const n = Number(s);
  return s !== undefined && s !== "" && Number.isFinite(n) ? n : undefined;
};

function fromConfig(e: z.infer<typeof ModelEntry>, cfg: Config): ModelValues {
  const { args, found } = splitArgs(e.args ?? cfg.extraArgs);
  const moe = num(found["--n-cpu-moe"] ?? found["-ncmoe"]);
  const kv = (found["-ctk"] ?? found["--cache-type-k"]) as KvType | undefined;
  const placement = e.placement ?? (moe !== undefined ? "moe" : "gpu");
  return {
    label: e.label, aliases: e.aliases, model: e.model,
    spec: e.spec ?? (e.draft ? "mtp" : "none"), ...(e.draft ? { draft: e.draft } : {}),
    placement, ...(moe !== undefined ? { nCpuMoe: moe } : {}),
    gpuMargin: e.gpuMargin ?? 6144,
    ctx: e.ctx ?? cfg.ctx,
    ubatch: e.ubatch ?? num(found["-ub"] ?? found["--ubatch-size"]) ?? 512,
    kv: e.kv ?? (kv && KV_TYPES.includes(kv) ? kv : "q8_0"),
    ...(e.mmproj ? { mmproj: e.mmproj } : {}),
    reasoning: e.reasoning ?? cfg.reasoning, thinkBudget: e.thinkBudget ?? -1, args, ...(e.exe ? { exe: e.exe } : {}),
  };
}

/** Arguments complets de llama-server pour un modèle. */
export function buildArgs(e: Entry, port: number): string[] {
  const kv = KV_TYPES.includes(e.kv) ? e.kv : "q8_0";
  const ub = Math.max(32, Math.round(e.ubatch || 512));
  const place = e.placement === "auto"
    ? ["--fit", "on", "--fit-target", String(Math.max(0, Math.round(e.gpuMargin)))]
    : ["--fit", "off", "-ngl", "99", ...(e.placement === "moe" && e.nCpuMoe ? ["--n-cpu-moe", String(e.nCpuMoe)] : [])];
  // MTP : fichier MTP séparé (-md) ou couches MTP incluses dans le modèle (sans fichier).
  const spec = e.spec === "ngram" ? ["--spec-type", "ngram-mod"]
    : e.spec === "mtp" ? ["--spec-type", "draft-mtp", ...(e.draft ? ["-md", e.draft, "-ngld", "99"] : [])]
    : e.spec === "draft" && e.draft ? ["--spec-type", "draft-simple", "-md", e.draft, "-ngld", "99"]
    : [];
  return [
    "--alias", e.id, "--jinja", "-c", String(e.ctx), "--host", "127.0.0.1", "--port", String(port),
    "--no-webui", "--reasoning", e.reasoning === "off" ? "off" : "on", "-m", e.model,
    "-ctk", kv, "-ctv", kv, "-ub", String(ub), "-b", String(Math.max(ub, 2048)),
    ...place, ...(e.mmproj ? ["-mm", e.mmproj] : []), ...spec,
    ...(e.reasoning !== "off" && e.thinkBudget >= 0 ? ["--reasoning-budget", String(e.thinkBudget)] : []),
    ...splitArgs(e.args).args,
  ];
}

function baseModels(cfg: Config): Record<string, ModelValues> {
  const out: Record<string, ModelValues> = {};
  for (const [id, e] of Object.entries(cfg.models)) out[id] = fromConfig(e, cfg);
  if (!Object.keys(out).length && cfg.model) {
    out.local = fromConfig({ label: cfg.alias, model: cfg.model, ...(cfg.draft ? { draft: cfg.draft } : {}), aliases: [] }, cfg);
  }
  return out;
}

/** Complète les valeurs d'un formulaire (champs absents ou mal typés). */
function clean(v: Record<string, unknown>, cfg: Config): ModelValues {
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map((y) => String(y).trim()).filter(Boolean) : []);
  const path = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  const placement = v.placement === "moe" || v.placement === "auto" ? v.placement : "gpu";
  const n = Number(v.nCpuMoe);
  const ctxN = Number(v.ctx);
  const ub = Number(v.ubatch);
  const margin = Number(v.gpuMargin);
  const draft = path(v.draft);
  const mmproj = path(v.mmproj);
  const exe = path(v.exe);
  // Ancienne forme : un brouillon sans type d'accélération = MTP.
  const spec: SpecType = SPEC_TYPES.includes(v.spec as SpecType) ? v.spec as SpecType : draft ? "mtp" : "none";
  return {
    label: String(v.label ?? "").trim(), aliases: list(v.aliases), model: String(v.model ?? "").trim(),
    spec, ...(draft ? { draft } : {}),
    placement, ...(placement === "moe" ? { nCpuMoe: Number.isFinite(n) && n > 0 ? Math.round(n) : 20 } : {}),
    gpuMargin: Number.isFinite(margin) && margin >= 0 ? Math.round(margin) : 6144,
    ctx: Number.isFinite(ctxN) && ctxN >= 512 ? Math.round(ctxN) : cfg.ctx,
    ubatch: Number.isFinite(ub) && ub >= 32 ? Math.round(ub) : 512,
    kv: KV_TYPES.includes(v.kv as KvType) ? v.kv as KvType : "q8_0",
    ...(mmproj ? { mmproj } : {}),
    reasoning: v.reasoning === "on" || v.reasoning === "tools" ? v.reasoning : "off",
    thinkBudget: Number.isFinite(Number(v.thinkBudget)) && Number(v.thinkBudget) >= -1 && v.thinkBudget !== "" && v.thinkBudget !== undefined ? Math.round(Number(v.thinkBudget)) : -1,
    args: Array.isArray(v.args) ? splitArgs(list(v.args)).args : splitArgs(cfg.extraArgs).args,
    ...(exe ? { exe } : {}),
  };
}

/** Exécute les tâches l'une après l'autre (changements de modèle : un seul llama-server à la fois). */
export function serial(): <R>(task: () => Promise<R>) => Promise<R> {
  let queue: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
}

/** Lance `next` ; s'il ne démarre pas, relance `previous` (s'il y en avait un) puis relève l'erreur d'origine. */
export async function startOrRestore<E>(next: E, previous: E | undefined, start: (e: E) => Promise<void>, stop: () => Promise<void>, onRestoreError?: (err: unknown) => void): Promise<void> {
  try {
    await start(next);
  } catch (err) {
    await stop();
    if (previous !== undefined) {
      try { await start(previous); } catch (back) { onRestoreError?.(back); }
    }
    throw err;
  }
}

const T = (fr: string, en: string) => ({ fr, en });

const FIELDS: FieldDef[] = [
  { key: "label", label: T("Nom affiché", "Display name"), type: "text", required: true, placeholder: T("Mistral Small 24B", "Mistral Small 24B") },
  { key: "aliases", label: T("Mots pour le demander à la voix", "Words to ask for it by voice"), type: "list",
    hint: T("« Floppy, passe sur Mistral »", "\"Floppy, switch to Mistral\"") },
  { key: "model", label: T("Fichier du modèle (GGUF)", "Model file (GGUF)"), type: "path", required: true, filters: [{ name: "GGUF", extensions: ["gguf"] }] },
  { key: "spec", label: T("Accélération", "Speed-up"), type: "select", default: "none", options: [
    { value: "none", label: T("Aucune", "None") },
    { value: "mtp", label: T("MTP (prédit plusieurs mots d'un coup)", "MTP (predicts several tokens at once)") },
    { value: "draft", label: T("Petit modèle brouillon", "Small draft model") },
    { value: "ngram", label: T("N-grammes (sans fichier, utile pour les textes répétés)", "N-grams (no file, helps on repeated text)") },
  ], hint: T("MTP : rend surtout les appels d'outils plus rapides.", "MTP: mostly speeds up tool calls.") },
  { key: "draft", label: T("Fichier MTP ou brouillon (GGUF)", "MTP or draft file (GGUF)"), type: "path", filters: [{ name: "GGUF", extensions: ["gguf"] }],
    hint: T("MTP : vide si les couches MTP sont déjà dans le modèle.", "MTP: leave empty if the MTP layers are inside the model."),
    showIf: { key: "spec", values: ["mtp", "draft"] } },
  { key: "placement", label: T("Où le faire tourner", "Where to run it"), type: "select", default: "gpu", options: [
    { value: "gpu", label: T("Tout sur le GPU", "All on the GPU") },
    { value: "moe", label: T("Experts en RAM (MoE)", "Experts in RAM (MoE)") },
    { value: "auto", label: T("Automatique (llama.cpp remplit le GPU)", "Automatic (llama.cpp fills the GPU)") },
  ] },
  { key: "nCpuMoe", label: T("Couches d'experts en RAM", "Expert layers in RAM"), type: "number", default: 20, min: 1, max: 200,
    hint: T("Option --n-cpu-moe de llama-server : plus il y en a, moins de GPU utilisé.", "llama-server --n-cpu-moe: the higher, the less GPU memory used."),
    showIf: { key: "placement", values: ["moe"] } },
  { key: "gpuMargin", label: T("Mémoire GPU laissée libre (Mo)", "GPU memory kept free (MB)"), type: "number", default: 6144, min: 0,
    hint: T("Pour la voix (TTS, STT) et l'écran.", "For the voice (TTS, STT) and the screen."),
    showIf: { key: "placement", values: ["auto"] } },
  { key: "ctx", label: T("Taille du contexte", "Context size"), type: "number", default: 32768, min: 512 },
  { key: "ubatch", label: T("Taille des paquets de lecture (-ub)", "Read batch size (-ub)"), type: "number", default: 512, min: 32,
    hint: T("Plus grand (2048) : lit bien plus vite les pages et les résultats d'outils, mais prend plus de mémoire GPU.", "Larger (2048): reads pages and tool results much faster, but uses more GPU memory.") },
  { key: "kv", label: T("Précision du cache du contexte", "Context cache precision"), type: "select", default: "q8_0", options: [
    { value: "f16", label: T("f16 (plus de mémoire)", "f16 (more memory)") },
    { value: "q8_0", label: T("q8_0 (conseillé)", "q8_0 (recommended)") },
    { value: "q4_0", label: T("q4_0 (moins de mémoire, un peu moins précis)", "q4_0 (less memory, slightly less precise)") },
  ] },
  { key: "mmproj", label: T("Vision : fichier mmproj (facultatif)", "Vision: mmproj file (optional)"), type: "path", filters: [{ name: "GGUF", extensions: ["gguf"] }] },
  { key: "reasoning", label: T("Réflexion", "Thinking"), type: "select", default: "off", options: [
    { value: "off", label: T("Coupée (plus rapide)", "Off (faster)") },
    { value: "tools", label: T("Après les outils (1re réponse rapide)", "After tools (fast first reply)") },
    { value: "on", label: T("Toujours", "Always") },
  ] },
  { key: "thinkBudget", label: T("Budget de réflexion (jetons)", "Thinking budget (tokens)"), type: "number", default: -1, min: -1,
    hint: T("Niveau de réflexion : ~256 bas, ~1024 moyen, ~4096 haut, -1 sans limite.", "Thinking level: ~256 low, ~1024 medium, ~4096 high, -1 unlimited."),
    showIf: { key: "reasoning", values: ["on", "tools"] } },
  { key: "exe", label: T("llama-server propre à ce modèle (facultatif)", "Model-specific llama-server (optional)"), type: "path", advanced: true,
    filters: [{ name: "llama-server", extensions: ["exe"] }],
    hint: T("Pour un modèle trop récent pour la version commune de llama.cpp.", "For a model too new for the shared llama.cpp build.") },
  { key: "args", label: T("Arguments avancés de llama-server", "Advanced llama-server arguments"), type: "list", advanced: true, default: splitArgs(DEFAULT_ARGS).args },
];

const KIND: ItemKind = {
  id: "gguf",
  label: T("Modèle local (GGUF)", "Local model (GGUF)"),
  description: T("Un fichier GGUF lancé par llama-server. Il rejoint la liste ; tu le choisis comme cerveau quand tu veux.",
    "A GGUF file run by llama-server. It joins the list; pick it as the brain whenever you like."),
  fields: FIELDS,
};

function sizeOf(file: string): number | undefined {
  try { return statSync(file).size; } catch { return undefined; }
}
const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Cherche des .gguf (profondeur limitée), sans les fichiers « mmproj » (vision). */
function scanGguf(dirs: string[], max = 60): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6 || out.length >= max) return;
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return out;
}

/** Même fichier (sans tenir compte de la casse sous un système qui l'ignore). */
const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
};

/** `known` : modèles choisis ; `search` : recherche en ligne (Hugging Face). Remplaçables pour les tests. */
export function makePlugin(known: LibraryEntry[] = KNOWN_MODELS, search: (q: string) => Promise<LibraryEntry[]> = (q) => searchHf(q)) {
return definePlugin<Config>({
  manifest: {
    id: "llm-llamacpp",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "cerveau", label: { fr: "Cerveau", en: "Brain" } },
    ],
    description: "LLM local (llama-server) : chaque modèle tourne à la demande, un seul chargé à la fois.",
    provides: ["llm", "completion"],
    // net : modèles choisis et recherche sur Hugging Face (voir known-models.ts, hf.ts).
    permissions: { exec: ["llama-server"], net: ["huggingface.co"] },
    addable: { section: "cerveau", label: "llama.cpp", description: { fr: "Modèles GGUF sur ce PC, lancés seulement quand ils servent. Un seul à la fois.", en: "GGUF models on this PC, run only while in use. One at a time." }, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const base = `http://127.0.0.1:${cfg.port}`;
    // Les modèles de floppy.yml sont la base ; l'utilisateur en ajoute, modifie, désactive ou supprime
    // (gardé dans <home>/items/<id>.json). Relu à chaque appel : un ajout est visible sans redémarrer.
    const store = ctx.items.store();
    const baseList = baseModels(cfg);
    const all = (): Entry[] => Object.entries(store.merge(baseList as unknown as Record<string, Record<string, unknown>>)).map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>, cfg), id }));
    const enabled = (): Entry[] => all().filter((m) => store.isEnabled(m.id));
    /**
     * Le llama-server en marche (un seul) : son modèle, ses utilisateurs (forks), prêt ou non. Lancé par le plugin
     * (pas par un fork) : il survit tant qu'un fork s'en sert, et s'arrête quand le dernier part.
     */
    type Server = { id: string; label: string; users: Set<Context>; ready: boolean; starting: Promise<void>; stop?: () => void };
    let server: Server | undefined;
    /** Pour la fenêtre des réglages : le modèle chargé (ou en chargement). */
    const runningOf = () => (server ? { id: server.id, ready: server.ready } : undefined);

    /** Prend le serveur pour ce fork (le lance si besoin). Refuse un 2e modèle : la mémoire du GPU. */
    const acquire = async (f: typeof ctx, e: Entry): Promise<void> => {
      if (server && server.id !== e.id) {
        throw new TextError(T(`${server.label} est chargé en ce moment et sert encore (un seul modèle à la fois) : réessaie quand il aura fini`,
          `${server.label} is loaded right now and still in use (one model at a time): try again when it's done`));
      }
      if (!server) {
        const srv: Server = { id: e.id, label: e.label, users: new Set(), ready: false, starting: Promise.resolve() };
        server = srv;
        srv.starting = (async () => {
          if (await healthy(base)) {
            // Un llama-server lancé hors de Floppy : réutilisé tel quel s'il a ce modèle, jamais arrêté par nous.
            const other = await modelId(base);
            if (!cfg.reuse || other !== e.id) throw new TextError(T(`le port ${cfg.port} est pris par un autre llama-server (modèle ${other ?? "?"}) : arrête-le d'abord`, `port ${cfg.port} is taken by another llama-server (model ${other ?? "?"}): stop it first`));
            ctx.log("info", `llama-server déjà lancé sur ${cfg.port} : réutilisé (modèle ${other})`);
          } else {
            srv.stop = await launch(e, (why) => { for (const u of [...srv.users]) if (u.alive) u.fail(why); });
          }
          srv.ready = true;
          ctx.audit.write({ kind: "llm.load", model: e.id });
          ctx.items.changed();
        })();
        ctx.items.changed();
      }
      const srv: Server = server;
      srv.users.add(f);
      f.effect(() => {
        srv.users.delete(f);
        if (srv.users.size || server !== srv) return;
        server = undefined;
        srv.stop?.();
        ctx.items.changed();
      });
      await srv.starting;
    };

    const findEntry = (id: string): Entry => {
      const e = enabled().find((m) => m.id === id);
      if (!e) throw new Error(`modèle inconnu ou désactivé : ${id}`);
      return e;
    };

    // Un fork par modèle choisi : il tient le serveur tant que le noyau garde le fork (quelqu'un s'en sert).
    ctx.offer("llm", {
      max: 1, // la mémoire du GPU
      items: () => enabled().map((m) => ({ id: m.id, label: m.label, aliases: m.aliases, slow: true })),
      async start(f, id) {
        const e = findEntry(id);
        await acquire(f, e);
        const service: LlmService = { label: e.label, baseURL: `${base}/v1`, model: e.id, thinking: e.reasoning };
        f.provide("llm", service);
      },
    });

    /** Modèle local choisi pour le cerveau principal (réglage slot.brain.main = "<cette entrée>/<modèle>"), sinon undefined. */
    const brainModel = (): Entry | undefined => {
      const v = ctx.settings.value("slot.brain.main");
      const prefix = `${ctx.id}/`;
      return typeof v === "string" && v.startsWith(prefix) ? enabled().find((m) => m.id === v.slice(prefix.length)) : undefined;
    };

    // Appels ponctuels (tri de la veille…) avec LE MODÈLE DU CERVEAU : même serveur, rien de plus sur le GPU.
    // Un seul élément, qui suit le cerveau principal : choisir un autre modèle ici chargerait un 2e modèle.
    ctx.offer("completion", {
      items: () => {
        const m = brainModel();
        return [{ id: "cerveau", label: T(`Modèle local du cerveau${m ? ` (${m.label})` : ""}`, `Brain's local model${m ? ` (${m.label})` : ""}`) }];
      },
      async start(f) {
        const e = brainModel();
        if (!e) throw new TextError(T("le cerveau principal n'est pas un modèle local : active un modèle local comme cerveau, ou choisis un autre cerveau pour ce rôle", "the main brain isn't a local model: activate a local model as the brain, or choose another brain for this role"));
        await acquire(f, e);
        f.provide("completion", { label: e.label, cloud: false, complete: (req) => localComplete(`${base}/v1`, e.id, req) } satisfies CompletionService);
      },
    });

    // ---- Chemins propres à chaque PC : réglages (fenêtre ou CLI), jamais à la voix (ils lancent un programme).
    let exeSetting = ctx.settings.saved<string>("llm_local_programme") ?? "";
    let dirsSetting = ctx.settings.saved<string>("llm_local_dossiers") ?? "";
    ctx.settings.declare([
      {
        key: "llm_local_programme", section: "cerveau", group: T("LLM local", "Local LLM"), type: "text", maxLength: 500, risk: "cli",
        label: T("Programme llama-server", "llama-server program"),
        description: T("Chemin complet du programme llama-server. Vide : Floppy le cherche dans le PATH.", "Full path to the llama-server program. Empty: Floppy looks for it in the PATH."),
        get: () => exeSetting, set: (v) => { exeSetting = String(v ?? "").trim(); },
      },
      {
        key: "llm_local_dossiers", section: "cerveau", group: T("LLM local", "Local LLM"), type: "text", maxLength: 2000, risk: "cli",
        label: T("Dossiers de modèles", "Model folders"),
        description: T("Dossiers où chercher des fichiers .gguf, séparés par « ; ». Les dossiers de LM Studio sont toujours lus.", "Folders to search for .gguf files, separated by “;”. LM Studio folders are always read."),
        get: () => dirsSetting, set: (v) => { dirsSetting = String(v ?? "").trim(); },
      },
    ]);
    /** llama-server à lancer : celui du modèle, du réglage, de la config, sinon celui du PATH. */
    const exeFor = (e: Entry): string => {
      const exe = e.exe || exeSetting || cfg.exe || findExe("llama-server");
      if (!exe) throw new TextError(T("llama-server introuvable : installe llama.cpp (https://github.com/ggml-org/llama.cpp/releases) et ajoute-le au PATH, ou indique son chemin dans Réglages → Cerveau → Programme llama-server.",
        "llama-server not found: install llama.cpp (https://github.com/ggml-org/llama.cpp/releases) and add it to the PATH, or give its path in Settings → Brain → llama-server program."));
      return exe;
    };
    const scanDirs = (): string[] => [...cfg.scanDirs, ...dirsSetting.split(";").map((d) => d.trim()).filter(Boolean)];

    /** Lance llama-server (tué à l'arrêt du plugin, ou par stop()) et attend qu'il réponde. */
    const launch = async (e: Entry, onCrash: (why: string) => void): Promise<() => void> => {
      const args = buildArgs(e, cfg.port);
      ctx.log("info", `lancement de llama-server : ${e.label}`, { model: e.model });
      const p: ChildProcess = ctx.spawn(exeFor(e), args, { stdio: ["ignore", "ignore", "pipe"] });
      let tail = "";
      p.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-3000); });
      let exited = false;
      let stopping = false;
      const last = () => tail.trim().split("\n").slice(-2).join(" | ");
      p.on("exit", (code) => { exited = true; if (!stopping && ctx.alive) onCrash(`llama-server s'est arrêté (code ${code}) : ${last()}`); });
      p.on("error", (err) => { exited = true; if (!stopping && ctx.alive) onCrash(`llama-server : ${err.message}`); });
      const stop = () => { stopping = true; if (p.pid) killTree(p); else p.kill?.(); };
      const deadline = Date.now() + cfg.startTimeout_s * 1000;
      while (!(await healthy(base))) {
        if (exited || !ctx.alive) { stop(); const l = last(); throw new TextError(T(`llama-server n'a pas démarré : ${l}`, `llama-server didn't start: ${l}`)); }
        if (Date.now() > deadline) { stop(); throw new TextError(T(`llama-server pas prêt après ${cfg.startTimeout_s} s`, `llama-server not ready after ${cfg.startTimeout_s} s`)); }
        await new Promise((r) => setTimeout(r, 500));
      }
      return stop;
    };

    // ---- Fenêtre des réglages : rubrique « Cerveau », fournisseur « LLM local »
    const info = (m: Entry): ItemInfo => {
      const size = sizeOf(m.model);
      const running = runningOf();
      const active = running?.id === m.id;
      const place = m.placement === "moe"
        ? T(`experts en RAM (${m.nCpuMoe ?? "?"} couches)`, `experts in RAM (${m.nCpuMoe ?? "?"} layers)`)
        : m.placement === "auto" ? T("placement automatique", "automatic placement")
        : T("tout sur le GPU", "all on the GPU");
      const on = store.isEnabled(m.id);
      return {
        id: m.id, label: m.label, enabled: on, active, kind: "gguf", aliases: m.aliases,
        detail: size === undefined
          ? T(`fichier introuvable · ${place.fr}`, `file not found · ${place.en}`)
          : T(`${gb(size)} Go · ${place.fr}`, `${gb(size)} GB · ${place.en}`),
        status: size === undefined ? "error" : !on ? "off" : active ? (running?.ready ? "ok" : "loading") : undefined,
        statusText: size === undefined ? T("fichier introuvable", "file not found")
          : !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
          : active ? (running?.ready ? T("chargé", "loaded") : T("chargement…", "loading…")) : undefined,
        values: { ...m, draft: m.draft ?? "", mmproj: m.mmproj ?? "", exe: m.exe ?? "" } as unknown as Record<string, unknown>,
        editable: true, removable: !active, toggleable: !active || !on,
      };
    };
    const refuseActive = (m: Entry, what: { fr: string; en: string }): OpResult | undefined =>
      runningOf()?.id === m.id ? { ok: false, text: T(`${m.label} est chargé en ce moment : active d'abord un autre cerveau, puis ${what.fr}.`, `${m.label} is loaded right now: activate another brain first, then ${what.en}.`) } : undefined;

    ctx.items.declare({
      id: "llm-local", section: "cerveau", order: 10, offers: "llm",
      label: T("LLM local", "Local LLM"),
      description: T("Modèles GGUF lancés par llama-server sur ce PC, seulement quand ils servent. Un seul chargé à la fois.", "GGUF models run by llama-server on this PC, only while in use. Only one loaded at a time."),
      addLabel: T("Ajouter un modèle local", "Add a local model"),
      kinds: [KIND],
      list: () => all().map(info),
      add: async (kind, values) => {
        if (kind !== "gguf") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
        const v = clean(values, cfg);
        if (!existsSync(v.model)) return { ok: false, text: T(`Fichier introuvable : ${v.model}`, `File not found: ${v.model}`) };
        if (v.draft && !existsSync(v.draft)) return { ok: false, text: T(`Modèle brouillon introuvable : ${v.draft}`, `Draft model not found: ${v.draft}`) };
        if (v.mmproj && !existsSync(v.mmproj)) return { ok: false, text: T(`Fichier mmproj introuvable : ${v.mmproj}`, `mmproj file not found: ${v.mmproj}`) };
        const id = store.add("gguf", v as unknown as Record<string, unknown>, v.label, Object.keys(baseList));
        ctx.items.changed();
        return { ok: true, id, text: T(`${v.label} ajouté. Il n'est pas chargé tout de suite : active-le comme cerveau quand tu veux.`, `${v.label} added. It isn't loaded right away: activate it as the brain whenever you like.`) };
      },
      update: async (id, values) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        const v = clean({ ...cur, ...values }, cfg);
        if (!existsSync(v.model)) return { ok: false, text: T(`Fichier introuvable : ${v.model}`, `File not found: ${v.model}`) };
        store.update(id, v as unknown as Record<string, unknown>);
        ctx.items.changed();
        return { ok: true, id, text: runningOf()?.id === id ? T(`${v.label} modifié. Les changements s'appliquent au prochain chargement.`, `${v.label} updated. Changes apply on the next load.`) : T(`${v.label} modifié.`, `${v.label} updated.`) };
      },
      remove: async (id) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        const no = refuseActive(cur, T("supprime-le", "delete it"));
        if (no) return no;
        store.remove(id);
        ctx.items.changed();
        return { ok: true, text: T(`${cur.label} supprimé de la liste (le fichier n'est pas touché).`, `${cur.label} removed from the list (the file isn't touched).`) };
      },
      setEnabled: async (id, on) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        if (!on) {
          const no = refuseActive(cur, T("désactive-le", "disable it"));
          if (no) return no;
        }
        store.setEnabled(id, on);
        ctx.items.changed();
        return { ok: true, text: on ? T(`${cur.label} disponible.`, `${cur.label} available.`) : T(`${cur.label} masqué : Floppy ne le voit plus (rien n'est supprimé).`, `${cur.label} hidden: Floppy no longer sees it (nothing is deleted).`) };
      },
      test: async (_kind, values) => {
        const v = clean(values, cfg);
        const size = sizeOf(v.model);
        if (size === undefined) return { ok: false, text: T(`Fichier introuvable : ${v.model}`, `File not found: ${v.model}`) };
        if (v.draft && sizeOf(v.draft) === undefined) return { ok: false, text: T(`Modèle brouillon introuvable : ${v.draft}`, `Draft model not found: ${v.draft}`) };
        if (v.mmproj && sizeOf(v.mmproj) === undefined) return { ok: false, text: T(`Fichier mmproj introuvable : ${v.mmproj}`, `mmproj file not found: ${v.mmproj}`) };
        if (v.placement === "auto") return { ok: true, text: T(`Placement automatique : llama.cpp remplit le GPU en laissant ${v.gpuMargin} Mo libres (modèle ${gb(size)} Go, contexte ${v.ctx}).`, `Automatic placement: llama.cpp fills the GPU, keeping ${v.gpuMargin} MB free (model ${gb(size)} GB, context ${v.ctx}).`) };
        // Estimation grossière : fichiers + cache du contexte (~1 Go pour 32 000 jetons en q8) + tampon de calcul (grandit avec -ub).
        const extra = (v.draft ? (sizeOf(v.draft) ?? 0) : 0) + (v.mmproj ? (sizeOf(v.mmproj) ?? 0) : 0);
        const kvScale = v.kv === "f16" ? 2 : v.kv === "q4_0" ? 0.55 : 1;
        const total = (size + extra) / 1024 ** 3 + (v.ctx / 32768) * kvScale + 0.5 * (v.ubatch / 512);
        const ramShare = v.placement === "moe" ? Math.min(1, (v.nCpuMoe ?? 20) / 40) * (size / 1024 ** 3) : 0;
        const gpu = Math.max(0, total - ramShare);
        const text = v.placement === "moe"
          ? T(`Estimation : ~${gpu.toFixed(1)} Go sur le GPU et ~${ramShare.toFixed(1)} Go en RAM (modèle ${gb(size)} Go, contexte ${v.ctx}).`,
            `Estimate: ~${gpu.toFixed(1)} GB on the GPU and ~${ramShare.toFixed(1)} GB in RAM (model ${gb(size)} GB, context ${v.ctx}).`)
          : T(`Estimation : ~${gpu.toFixed(1)} Go sur le GPU (modèle ${gb(size)} Go, contexte ${v.ctx}). Trop juste avec la voix et le bureau ? Essaie « Experts en RAM » ou un contexte plus petit.`,
            `Estimate: ~${gpu.toFixed(1)} GB on the GPU (model ${gb(size)} GB, context ${v.ctx}). Too tight with the voice and the desktop? Try "Experts in RAM" or a smaller context.`);
        return { ok: true, text };
      },
      action: async (_id, action) => {
        if (action !== "scan") return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
        const norm = (f: string) => f.replace(/\\/g, "/").toLowerCase();
        const known = new Set(all().map((m) => norm(m.model)));
        const found = scanGguf(scanDirs()).filter((f) => !known.has(norm(f)));
        return { ok: true, text: found.length ? T(`${found.length} fichier(s) GGUF trouvé(s) :\n${found.join("\n")}`, `${found.length} GGUF file(s) found:\n${found.join("\n")}`) : T("Aucun nouveau fichier GGUF trouvé.", "No new GGUF file found.") };
      },
    });

    // Modèles à télécharger (choisis, ou trouvés sur Hugging Face) : une fois sur le disque, ils rejoignent la liste.
    // Un modèle en plusieurs fichiers se lance par le premier (llama-server lit les autres).
    const fileOf = (e: LibraryEntry) => resolve(ctx.downloads.dir, e.files[0]!.path);
    const mine = (e: LibraryEntry) => all().filter((m) => samePath(m.model, fileOf(e)));
    modelLibrary(ctx, {
      id: "llm-local-library", section: "cerveau", order: 11, offers: "llm",
      label: T("Modèles GGUF", "GGUF models"),
      searchHint: T("Chercher sur Hugging Face (ex. gemma, qwen, mistral)", "Search Hugging Face (e.g. gemma, qwen, mistral)"),
      entries: () => known,
      search,
      has: (e) => mine(e).length > 0,
      installed: (e) => {
        if (mine(e).length) return;
        const label = typeof e.label === "string" ? e.label : (e.label[ctx.uiLang()] ?? e.label.fr);
        const v = clean({ label, model: fileOf(e) }, cfg);
        store.add("gguf", v as unknown as Record<string, unknown>, label, Object.keys(baseList));
        ctx.items.changed();
      },
      removed: (e) => {
        const list = mine(e);
        const loaded = list.find((m) => runningOf()?.id === m.id);
        if (loaded) throw new TextError(T(`${loaded.label} est chargé en ce moment : active d'abord un autre cerveau.`, `${loaded.label} is loaded right now: activate another brain first.`));
        for (const m of list) store.remove(m.id);
        ctx.items.changed();
      },
    });
  },
});
}

export default makePlugin();

/** Un appel ponctuel à llama-server (sans réflexion : tri, résumé). Avec un schéma, la réponse JSON est lue et vérifiée. */
export async function localComplete(baseURL: string, model: string, req: { system: string; prompt: string; schema?: Record<string, unknown>; signal?: AbortSignal }): Promise<{ text: string; json?: unknown }> {
  const once = async (): Promise<{ text: string; json?: unknown }> => {
    const body: Record<string, unknown> = {
      model, temperature: 0.2,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
      // Pas de réflexion pour un tri : plus rapide, et la réponse reste du JSON pur.
      chat_template_kwargs: { enable_thinking: false }, thinking_budget_tokens: 0,
      ...(req.schema ? { response_format: { type: "json_schema", json_schema: { name: "reponse", schema: req.schema } } } : {}),
    };
    const r = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(req.signal ? { signal: req.signal } : {}) });
    if (!r.ok) throw new Error(`le modèle local a répondu ${r.status} : ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const text = String(data.choices?.[0]?.message?.content ?? "").trim();
    if (!req.schema) return { text };
    const json = parseJsonLoose(text);
    if (json === undefined) throw new Error("le modèle local n'a pas donné de JSON valide");
    return { text, json };
  };
  try { return await once(); } catch (e) {
    if (req.signal?.aborted || !(e instanceof Error) || !e.message.includes("JSON")) throw e;
    return once(); // un 2e essai si le JSON est cassé
  }
}

/** JSON d'une réponse, même entouré de ``` ou de texte. */
export function parseJsonLoose(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { /* on cherche le premier bloc */ }
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (!m) return undefined;
  try { return JSON.parse(m[0]); } catch { return undefined; }
}
