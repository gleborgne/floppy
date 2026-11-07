// Plugin `tts-audiocpp` : voix locales (audio.cpp, `audiocpp_server.exe`), comme llama.cpp mais pour le son.
// - Le plugin tient le catalogue des modèles (fenêtre des réglages, Voix) et offre le service `tts` modèle par modèle.
// - Chaque modèle choisi tourne dans un fork : le serveur vit et meurt avec lui. max 1 : un seul modèle dans la mémoire du GPU.
// - Le fork écrit son dossier de travail (server.json + voices/), lance le serveur, attend qu'il réponde, puis parle en flux (SSE).
import { z } from "zod";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { definePlugin, modelLibrary, programLibrary, restartsModels, failoverText, type ProgramBuild, findExe, killTree, Pcm16Decoder, wavPcm, TextError, type Context, type FieldDef, type ItemInfo, type ItemKind, type ModelNeeds, type OpResult, type Text, type TtsChunk, type TtsService } from "@floppy/core";

/** Aucun dossier imposé : ceux de l'utilisateur viennent du réglage « tts_local_dossiers » (ou de la config). */
export const DEFAULT_SCAN_DIRS: string[] = [];

const ModelEntry = z.object({
  label: z.string(),
  model: z.string(),
  famille: z.string().optional(),
  voix: z.enum(["clone", "integree"]).optional(),
  refWav: z.string().optional(),
  refText: z.string().optional(),
  speaker: z.string().optional(),
  instruct: z.string().optional(),
  langue: z.string().optional(),
  rate: z.number().int().optional(),
  mode: z.enum(["streaming", "offline"]).optional(),
});

const Config = z.object({
  /** Programme audiocpp_server. Absent : réglage « tts_local_programme », sinon trouvé dans le PATH. */
  exe: z.string().optional(),
  port: z.number().int().default(8089),
  /** « auto » : cuda avec une carte NVIDIA, sinon le processeur (audio.cpp n'a pas encore Metal ni Vulkan). */
  backend: z.enum(["auto", "cuda", "vulkan", "metal", "cpu"]).default("auto"),
  device: z.number().int().default(0),
  threads: z.number().int().default(4),
  startTimeout_s: z.number().default(180),
  /** Dossiers où chercher des .gguf (action « scan »). */
  scanDirs: z.array(z.string()).default(DEFAULT_SCAN_DIRS),
  /** Modèles de base (floppy.yml) : { qwen3: { label, model, voix, refWav, refText… } }. */
  models: z.record(z.string(), ModelEntry).default({}),
});
export type Config = z.infer<typeof Config>;

/** Un modèle tel que la fenêtre le montre. */
export interface ModelValues {
  label: string;
  model: string;
  famille: string;
  familleAutre: string;
  voix: "clone" | "integree";
  refWav: string;
  refText: string;
  speaker: string;
  instruct: string;
  langue: string;
  /** 0 = automatique selon la famille. */
  rate: number;
  mode: "streaming" | "offline";
}
export type Entry = ModelValues & { id: string };

const FAMILLES = ["qwen3_tts", "voxcpm2", "pocket_tts", "supertonic"];

/** Fréquence de sortie par famille (Hz). Absente : 24000. */
const RATES: Record<string, number> = { voxcpm2: 48000, supertonic: 44100 };

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** Complète les valeurs d'un formulaire (champs absents ou mal typés). */
export function clean(v: Record<string, unknown>): ModelValues {
  const fam = str(v.famille) || "qwen3_tts";
  const known = FAMILLES.includes(fam) || fam === "autre";
  const rate = Number(v.rate);
  return {
    label: str(v.label), model: str(v.model),
    // Une famille inconnue venant d'floppy.yml devient « autre ».
    famille: known ? fam : "autre", familleAutre: known ? str(v.familleAutre) : fam,
    voix: v.voix === "integree" ? "integree" : "clone",
    refWav: str(v.refWav), refText: typeof v.refText === "string" ? v.refText.trim() : "", speaker: str(v.speaker),
    // Langue absente : celle de l'assistant au moment de parler (voir speechRequest).
    instruct: str(v.instruct), langue: typeof v.langue === "string" ? v.langue.trim() : "",
    rate: Number.isFinite(rate) && rate >= 8000 ? Math.round(rate) : 0,
    mode: v.mode === "offline" ? "offline" : "streaming",
  };
}

/** Nom de la famille pour le serveur. */
export const familyOf = (m: ModelValues): string => (m.famille === "autre" ? m.familleAutre : m.famille) || "qwen3_tts";

/** Fréquence de la voix : celle du réglage, sinon celle de la famille. */
export const rateOf = (m: ModelValues): number => m.rate || RATES[familyOf(m)] || 24000;

/** Nom du modèle côté serveur et de la voix dans la bibliothèque. */
export const MODEL_ID = "modele";
export const VOICE_NAME = "voix";

const slash = (p: string) => p.replace(/\\/g, "/");

/** Contenu de server.json pour un modèle. dirs.voiceDir : dossier des voix de ce modèle. */
type ServerCfg = Pick<Config, "port" | "device" | "threads"> & { backend: Exclude<Config["backend"], "auto"> };

export function serverConfig(item: ModelValues, cfg: ServerCfg, dirs: { voiceDir: string }): Record<string, unknown> {
  return {
    host: "127.0.0.1", port: cfg.port, backend: cfg.backend, device: cfg.device, threads: cfg.threads,
    lazy_load: false, max_loaded_models: 1, ui: false, voice_dir: slash(dirs.voiceDir),
    models: [{ id: MODEL_ID, family: familyOf(item), path: slash(item.model), task: "tts", mode: item.mode }],
  };
}

/** Corps de la requête de parole. `lang` : langue de l'assistant, utilisée quand le modèle n'en impose pas. */
export function speechRequest(item: ModelValues, text: string, lang?: string): Record<string, unknown> {
  const language = item.langue || lang;
  const options: Record<string, unknown> = {};
  const fam = familyOf(item);
  if (fam === "voxcpm2") options.retry_badcase = false;
  if (item.voix === "integree") {
    if (item.speaker) options.voice_id = item.speaker;
  } else if (!item.refText && (fam === "qwen3_tts" || fam === "voxcpm2")) options.x_vector_only_mode = true; // option propre à ces familles
  return {
    model: MODEL_ID, input: text,
    ...(item.voix === "clone" ? { voice: VOICE_NAME } : {}),
    ...(item.mode === "streaming" ? { stream_format: "sse" } : {}),
    ...(language ? { language } : {}),
    ...(item.instruct ? { instructions: item.instruct } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

/** Écrit server.json et voices/ (voix clonée + prompt_text) dans le dossier du modèle. */
export function prepareDir(dir: string, item: ModelValues, cfg: ServerCfg): string {
  const voiceDir = join(dir, "voices");
  rmSync(voiceDir, { recursive: true, force: true });
  mkdirSync(voiceDir, { recursive: true });
  if (item.voix === "clone" && item.refWav) {
    copyFileSync(item.refWav, join(voiceDir, `${VOICE_NAME}.wav`));
    if (item.refText) writeFileSync(join(voiceDir, "prompt_text"), `${VOICE_NAME}|${item.refText.replace(/\s*[\r\n]+\s*/g, " ")}\n`, "utf8");
  }
  const file = join(dir, "server.json");
  writeFileSync(file, JSON.stringify(serverConfig(item, cfg, { voiceDir }), null, 2), "utf8");
  return file;
}

/**
 * Flux SSE d'audio.cpp -> blocs PCM. Les événements `speech.audio.delta` portent de l'audio en base64 (PCM 16 bits mono) ;
 * les autres événements sont ignorés, un événement d'erreur lève une erreur. Les coupures du réseau peuvent tomber
 * au milieu d'une ligne, d'un caractère ou d'un échantillon : tout est recollé.
 */
export async function* ssePcm(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Int16Array> {
  const text = new TextDecoder();
  const pcm = new Pcm16Decoder();
  let buf = "";
  const handle = (line: string): Int16Array | undefined => {
    const l = line.replace(/\r$/, "");
    if (!l.startsWith("data:")) return undefined;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") return undefined;
    let d: { type?: string; audio?: string; delta?: string; error?: unknown; message?: string };
    try { d = JSON.parse(payload); } catch { return undefined; }
    if (d.type === "error" || (d.error !== undefined && d.error !== null)) {
      const e = d.error;
      const why = typeof e === "string" ? e : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : d.message ?? "erreur inconnue";
      throw new Error(`la voix locale a répondu une erreur : ${why}`);
    }
    if (d.type !== undefined && d.type !== "speech.audio.delta") return undefined;
    const b64 = d.audio ?? d.delta;
    if (!b64) return undefined;
    const out = pcm.push(Buffer.from(b64, "base64"));
    return out.length ? out : undefined;
  };
  for await (const bytes of stream) {
    buf += text.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const out = handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (out) yield out;
    }
  }
  buf += text.decode();
  if (buf) { const out = handle(buf); if (out) yield out; }
  pcm.finish();
}

/** WAV complet (mode hors ligne) -> fréquence + PCM 16 bits mono. */
export { wavPcm };

const T = (fr: string, en: string) => ({ fr, en });

const FIELDS: FieldDef[] = [
  { key: "label", label: T("Nom affiché", "Display name"), type: "text", required: true, placeholder: T("Qwen3 TTS (ma voix)", "Qwen3 TTS (my voice)") },
  { key: "model", label: T("Fichier du modèle (GGUF)", "Model file (GGUF)"), type: "path", required: true, filters: [{ name: "GGUF", extensions: ["gguf"] }] },
  { key: "famille", label: T("Famille du modèle", "Model family"), type: "select", default: "qwen3_tts", options: [
    { value: "qwen3_tts", label: T("Qwen3 TTS", "Qwen3 TTS") },
    { value: "voxcpm2", label: T("VoxCPM2", "VoxCPM2") },
    { value: "pocket_tts", label: T("Pocket TTS (processeur, voix clonée)", "Pocket TTS (CPU, cloned voice)") },
    { value: "supertonic", label: T("Supertonic (processeur, voix F1…F5, M1…M5)", "Supertonic (CPU, voices F1…F5, M1…M5)") },
    { value: "autre", label: T("Autre (je donne le nom)", "Other (I give the name)") },
  ] },
  { key: "familleAutre", label: T("Nom de la famille", "Family name"), type: "text", placeholder: T("kokoro_tts", "kokoro_tts"),
    hint: T("Le nom d'audio.cpp (voir le dossier model_specs).", "The audio.cpp name (see the model_specs folder)."), showIf: { key: "famille", values: ["autre"] } },
  { key: "voix", label: T("Voix", "Voice"), type: "select", default: "clone", options: [
    { value: "clone", label: T("Clonée depuis un enregistrement (WAV)", "Cloned from a recording (WAV)") },
    { value: "integree", label: T("Voix du modèle (ex. Vivian)", "Built-in voice (e.g. Vivian)") },
  ] },
  { key: "refWav", label: T("Enregistrement de la voix (WAV)", "Voice recording (WAV)"), type: "path", filters: [{ name: "WAV", extensions: ["wav"] }],
    hint: T("Quelques secondes de voix claire, sans bruit.", "A few seconds of clear voice, no noise."), showIf: { key: "voix", values: ["clone"] } },
  { key: "refText", label: T("Ce que dit l'enregistrement", "What the recording says"), type: "textarea",
    hint: T("Obligatoire pour Qwen3 Base. Laisse vide pour copier seulement le timbre (x_vector_only_mode).", "Required for Qwen3 Base. Leave empty to copy only the timbre (x_vector_only_mode)."),
    showIf: { key: "voix", values: ["clone"] } },
  { key: "speaker", label: T("Nom de la voix intégrée", "Built-in voice name"), type: "text", placeholder: T("Vivian", "Vivian"), showIf: { key: "voix", values: ["integree"] } },
  { key: "instruct", label: T("Style (facultatif)", "Style (optional)"), type: "text", advanced: true,
    hint: T("Ex. « voix calme et chaleureuse ».", "E.g. \"calm, warm voice\".") },
  { key: "langue", label: T("Langue", "Language"), type: "text", default: "", advanced: true,
    hint: T("Code de langue (fr, en…). Vide : la langue de l'assistant.", "Language code (fr, en…). Empty: the assistant language.") },
  { key: "rate", label: T("Fréquence de l'audio (Hz)", "Audio rate (Hz)"), type: "number", advanced: true, min: 8000,
    hint: T("Vide = automatique (24000 pour Qwen3 et Pocket TTS, 48000 pour VoxCPM2, 44100 pour Supertonic).", "Empty = automatic (24000 for Qwen3 and Pocket TTS, 48000 for VoxCPM2, 44100 for Supertonic).") },
  { key: "mode", label: T("Mode du serveur", "Server mode"), type: "select", default: "streaming", advanced: true, options: [
    { value: "streaming", label: T("En flux (la voix part vite)", "Streaming (voice starts fast)") },
    { value: "offline", label: T("Hors ligne (phrase entière)", "Offline (whole sentence)") },
  ], hint: T("Certains modèles (VoiceDesign) ne savent pas parler en flux.", "Some models (VoiceDesign) cannot stream.") },
];

const KIND: ItemKind = {
  id: "gguf",
  label: T("Modèle de voix local (GGUF)", "Local voice model (GGUF)"),
  description: T("Un fichier GGUF lancé par audio.cpp. Il rejoint la liste ; tu l'actives comme voix quand tu veux.",
    "A GGUF file run by audio.cpp. It joins the list; activate it as the voice whenever you like."),
  fields: FIELDS,
};

function sizeOf(file: string): number | undefined {
  try { return statSync(file).size; } catch { return undefined; }
}
const gbNum = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const gb = (bytes: number) => String(gbNum(bytes)).replace(".", ",");

/** Cherche des .gguf (profondeur limitée), sans les fichiers « mmproj ». Les noms de voix d'abord. */
export function scanGguf(dirs: string[], max = 60): string[] {
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
  const voice = (p: string) => (/tts|voxcpm|kokoro/i.test(basename(p)) ? 0 : 1);
  return out.sort((a, b) => voice(a) - voice(b));
}

import { KNOWN_VOICE_MODELS, type KnownVoiceModel } from "./known-voices.ts";
import { AUDIOCPP_BUILDS, AUDIOCPP_VERSION } from "./known-builds.ts";

/** Même fichier (sans tenir compte de la casse sous un système qui l'ignore). */
const samePath = (a: string, b: string): boolean => {
  const n = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
};

/**
 * Ce que demande un modèle de voix : Pocket TTS et Supertonic parlent en temps réel sur le processeur ;
 * Qwen3-TTS demande une carte NVIDIA (~4,5 Go mesurés pour la 1.7B).
 */
export function voiceNeeds(k: Pick<KnownVoiceModel, "famille">): ModelNeeds {
  return k.famille === "qwen3_tts" ? { memory: 4.5 * 1024 ** 3, device: "gpu", backends: ["cuda", "vulkan", "metal"] } : { memory: 0.8 * 1024 ** 3, device: "cpu" };
}

/** `builds` : archives d'audio.cpp (remplaçables pour les tests). */
export function makePlugin(known: KnownVoiceModel[] = KNOWN_VOICE_MODELS, builds: ProgramBuild[] = AUDIOCPP_BUILDS) {
return definePlugin<Config>({
  manifest: {
    id: "tts-audiocpp",
    version: "0.1.0",
    licence: "MIT",
    sections: [{ id: "voix", label: { fr: "Voix", en: "Voice" } }],
    description: "Voix locales (audio.cpp) : un modèle de synthèse vocale à la fois, lancé seulement quand il sert.",
    provides: ["tts"],
    // net : téléchargement des modèles connus (voir known-voices.ts).
    permissions: { exec: ["audiocpp_server"], net: ["huggingface.co", "github.com"] },
    addable: { section: "voix", label: "audio.cpp", description: { fr: "Modèles de voix GGUF sur ce PC (voix clonée ou intégrée), lancés seulement quand ils servent.", en: "GGUF voice models on this PC (cloned or built-in voice), run only while in use." }, single: true },
  },
  config: Config,
  apply(ctx, cfg) {
    const base = `http://127.0.0.1:${cfg.port}`;
    const store = ctx.items.store();
    const baseList: Record<string, ModelValues> = {};
    for (const [id, e] of Object.entries(cfg.models)) baseList[id] = clean(e as unknown as Record<string, unknown>);
    const all = (): Entry[] => Object.entries(store.merge(baseList as unknown as Record<string, Record<string, unknown>>)).map(([id, v]) => ({ ...clean(v as unknown as Record<string, unknown>), id }));
    const enabled = (): Entry[] => all().filter((m) => store.isEnabled(m.id));
    /** Modèles chargés (ou en chargement) : id -> prêt ou non. */
    const running = new Map<string, boolean>();

    const healthy = async (): Promise<boolean> => {
      try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
    };

    // ---- Chemins propres à chaque PC : réglages (fenêtre ou CLI), jamais à la voix (ils lancent un programme).
    let exeSetting = ctx.settings.saved<string>("tts_local_programme") ?? "";
    let dirsSetting = ctx.settings.saved<string>("tts_local_dossiers") ?? "";
    ctx.settings.declare([
      {
        key: "tts_local_programme", section: "voix", group: T("audio.cpp", "audio.cpp"), type: "text", maxLength: 500, risk: "cli",
        label: T("Programme audio.cpp", "audio.cpp program"),
        description: T("Chemin complet du programme audiocpp_server. Vide : Floppy le cherche dans le PATH.", "Full path to the audiocpp_server program. Empty: Floppy looks for it in the PATH."),
        get: () => exeSetting, set: (v) => { exeSetting = String(v ?? "").trim(); },
      },
      {
        key: "tts_local_dossiers", section: "voix", group: T("audio.cpp", "audio.cpp"), type: "text", maxLength: 2000, risk: "cli",
        label: T("Dossiers de modèles de voix", "Voice model folders"),
        description: T("Dossiers où chercher des fichiers .gguf de voix, séparés par « ; ».", "Folders to search for voice .gguf files, separated by “;”."),
        get: () => dirsSetting, set: (v) => { dirsSetting = String(v ?? "").trim(); },
      },
    ]);
    /** audiocpp_server à lancer : réglage, config, sinon PATH. Undefined s'il est introuvable. */
    // Le programme audiocpp_server, téléchargé par Floppy dans la bonne version pour la machine (CUDA, Vulkan, Metal…).
    const program = programLibrary(ctx, {
      id: "voix-locale-program", section: "voix", order: 20, offers: "tts", label: "audio.cpp", program: "audiocpp_server",
      version: AUDIOCPP_VERSION, builds, licence: { name: "Apache-2.0", url: "https://github.com/0xShug0/audio.cpp/blob/main/LICENSE" },
      // Nouvelle version pour la puce graphique, repli, réparation : la voix en marche repart avec.
      changed: (why) => { ctx.items.changed(); if (restartsModels(why)) void ctx.restartOffers("tts"); },
    });
    /** Le moteur est choisi par Floppy, avec son propre programme (pas un programme ou un moteur choisi à la main). */
    const ours = (): boolean => cfg.backend === "auto" && !exeSetting && !cfg.exe && !!program.path();
    /** Voix qui demande la puce graphique (Qwen3-TTS). */
    const gpuVoice = (m: Entry): boolean => voiceNeeds({ famille: familyOf(m) as KnownVoiceModel["famille"] }).device === "gpu";
    /**
     * Une voix de la puce graphique est dans la liste et Floppy n'a que la version « processeur » d'audio.cpp
     * (réglage de départ minimal, puis voix plus costaude choisie plus tard) : la bonne version se télécharge en fond.
     */
    const upgrade = (): void => {
      if (ours() && enabled().some(gpuVoice)) void program.want("gpu").catch((err) => ctx.log("warn", "audio.cpp : mise à niveau impossible", { err: String(err) }));
    };
    /** audiocpp_server à lancer : réglage, config, celui de Floppy, sinon celui du PATH. */
    const exePath = (): string | undefined => exeSetting || cfg.exe || program.path() || findExe("audiocpp_server");
    const missingExe = T("audio.cpp introuvable : installe audiocpp_server et ajoute-le au PATH, ou indique son chemin dans Réglages → Voix → Programme audio.cpp.",
      "audio.cpp not found: install audiocpp_server and add it to the PATH, or give its path in Settings → Voice → audio.cpp program.");
    /** Moteur d'audio.cpp : celui de la config, ou (auto) cuda si la machine a une carte NVIDIA. */
    const backend = async (): Promise<ServerCfg["backend"]> => {
      if (cfg.backend !== "auto") return cfg.backend;
      // Le programme de Floppy en service : son moteur (une archive « processeur » ne sait pas faire CUDA).
      const mine = program.installed();
      const ours = mine && !exeSetting && !cfg.exe ? mine.backend : undefined;
      if (ours) return ours === "rocm" || ours === "sycl" ? "vulkan" : ours;
      return (await ctx.machine()).backends.includes("cuda") ? "cuda" : "cpu";
    };
    const scanDirs = (): string[] => [...cfg.scanDirs, ...dirsSetting.split(";").map((d) => d.trim()).filter(Boolean)];

    /** Lance le serveur pour ce fork (tué avec lui) et attend qu'il réponde. */
    const launch = async (f: Context, e: Entry): Promise<void> => {
      if (!existsSync(e.model)) throw new TextError(T(`fichier du modèle introuvable : ${e.model}`, `model file not found: ${e.model}`));
      if (e.voix === "clone" && !e.refWav) throw new TextError(T("voix clonée : choisis l'enregistrement de la voix (WAV) dans les réglages", "cloned voice: pick the voice recording (WAV) in the settings"));
      if (e.voix === "clone" && !existsSync(e.refWav)) throw new TextError(T(`enregistrement de la voix introuvable : ${e.refWav}`, `voice recording not found: ${e.refWav}`));
      if (await healthy()) throw new TextError(T(`le port ${cfg.port} est déjà pris par un autre serveur : arrête-le d'abord (ou change le port)`, `port ${cfg.port} is already taken by another server: stop it first (or change the port)`));
      const dir = join(f.home, "tts-audiocpp", e.id);
      mkdirSync(dir, { recursive: true });
      const file = prepareDir(dir, e, { ...cfg, backend: await backend() });
      f.log("info", `lancement d'audio.cpp : ${e.label}`, { model: e.model });
      const exe = exePath();
      if (!exe) throw new TextError(missingExe);
      const p: ChildProcess = f.spawn(exe, ["--config", file], { stdio: ["ignore", "pipe", "pipe"], cwd: dirname(exe) });
      let tail = "";
      const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-3000); };
      p.stdout?.on("data", keep);
      p.stderr?.on("data", keep);
      let exited = false;
      let stopping = false;
      const last = () => tail.trim().split("\n").slice(-3).join(" | ");
      p.on("exit", (code) => { exited = true; if (!stopping && f.alive) f.fail(`audio.cpp s'est arrêté (code ${code}) : ${last()}`); });
      p.on("error", (err) => { exited = true; if (!stopping && f.alive) f.fail(`audio.cpp : ${err.message}`); });
      const stop = () => { stopping = true; if (p.pid) killTree(p); else p.kill?.(); };
      f.effect(stop);
      const deadline = Date.now() + cfg.startTimeout_s * 1000;
      while (!(await healthy())) {
        if (exited || !f.alive) { stop(); throw new Error(`audio.cpp n'a pas démarré : ${last()}`); }
        if (Date.now() > deadline) { stop(); throw new Error(`audio.cpp pas prêt après ${cfg.startTimeout_s} s : ${last()}`); }
        await new Promise((r) => setTimeout(r, 500));
      }
    };

    const makeService = (f: Context, e: Entry): TtsService => {
      const rate = rateOf(e);
      const active = new Set<AbortController>();
      f.effect(() => { for (const a of active) a.abort(); });
      return {
        name: `${e.label} (audio.cpp)`,
        availability: () => (f.alive ? { ready: true } : { ready: false, reason: "voix locale arrêtée" }),
        async *speak(text, opts) {
          if (!f.alive) throw new Error("voix locale arrêtée");
          const abort = new AbortController();
          active.add(abort);
          const signal = AbortSignal.any([opts.signal, abort.signal, AbortSignal.timeout(120_000)]);
          try {
            let r: Response;
            try {
              r = await fetch(`${base}/v1/audio/speech`, {
                method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(speechRequest(e, text, ctx.assistant.language)),
              });
            } catch (err) {
              if (signal.aborted) throw err;
              throw new Error(`la voix locale ne répond pas : ${err instanceof Error ? err.message : String(err)}`);
            }
            if (!r.ok || !r.body) throw new Error(`la voix locale a répondu ${r.status} : ${(await r.text().catch(() => "")).slice(0, 200)}`);
            if (e.mode === "offline") {
              const w = wavPcm(new Uint8Array(await r.arrayBuffer()));
              if (w.pcm.length) yield { rate: w.rate, pcm: w.pcm } satisfies TtsChunk;
              return;
            }
            for await (const pcm of ssePcm(r.body)) {
              signal.throwIfAborted();
              yield { rate, pcm } satisfies TtsChunk;
            }
          } finally { active.delete(abort); }
        },
      };
    };

    ctx.offer("tts", {
      max: 1, // la mémoire du GPU
      items: () => enabled().map((m) => ({ id: m.id, label: m.label, slow: true })),
      async start(f, id) {
        const e = enabled().find((m) => m.id === id);
        if (!e) throw new Error(`voix inconnue ou désactivée : ${id}`);
        running.set(id, false);
        ctx.items.changed();
        f.effect(() => { running.delete(id); ctx.items.changed(); });
        if (gpuVoice(e)) upgrade();
        try {
          await launch(f, e);
        } catch (err) {
          // Ne démarre pas : si c'est le programme lui-même (pilote, bibliothèque), Floppy passe à la version suivante.
          const next = ours() ? await program.failed(String(err)).catch(() => undefined) : undefined;
          throw next ? new TextError(failoverText("audio.cpp", next)) : err;
        }
        running.set(id, true);
        ctx.audit.write({ kind: "tts.load", model: e.id });
        ctx.items.changed();
        f.provide("tts", makeService(f, e));
      },
    });

    // ---- Fenêtre des réglages : rubrique « Voix », fournisseur « Voix locale »
    const voiceText = (m: Entry) => m.voix === "clone"
      ? T(`voix clonée${m.refWav ? ` (${basename(m.refWav)})` : ""}`, `cloned voice${m.refWav ? ` (${basename(m.refWav)})` : ""}`)
      : T(`voix intégrée${m.speaker ? ` (${m.speaker})` : ""}`, `built-in voice${m.speaker ? ` (${m.speaker})` : ""}`);
    /** Fichier GGUF d'un modèle connu, dans le dossier des téléchargements. */
    const knownFile = (k: KnownVoiceModel) => resolve(ctx.downloads.dir, k.model);
    /**
     * Plusieurs voix d'un même fichier (ex. les voix de Pocket TTS) : groupées sous le modèle. La fenêtre fait alors
     * choisir le modèle, puis la voix. Un fichier qui n'a qu'une voix reste une ligne simple.
     */
    const groupOf = (m: Entry): Pick<ItemInfo, "group"> => {
      if (all().filter((x) => samePath(x.model, m.model)).length < 2) return {};
      const k = known.find((x) => samePath(knownFile(x), m.model));
      return { group: { id: m.model.replace(/\\/g, "/").toLowerCase(), label: k?.label ?? basename(m.model), ...(k?.description ? { detail: k.description } : {}) } };
    };
    const info = (m: Entry): ItemInfo => {
      const size = sizeOf(m.model);
      const q = quantOf(m.model);
      const ready = running.get(m.id);
      const active = ready !== undefined;
      const on = store.isEnabled(m.id);
      const vt = voiceText(m);
      const fam = familyOf(m);
      const noRef = m.voix === "clone" && !m.refWav;
      return {
        id: m.id, label: m.label, enabled: on, active, kind: "gguf",
        detail: size === undefined
          ? T(`fichier introuvable · ${fam} · ${vt.fr}`, `file not found · ${fam} · ${vt.en}`)
          : T(`${gb(size)} Go · ${q ? `${q.fr} · ` : ""}${fam} · ${vt.fr}`, `${gb(size)} GB · ${q ? `${q.en} · ` : ""}${fam} · ${vt.en}`),
        status: size === undefined ? "error" : !on ? "off" : active ? (ready ? "ok" : "loading") : noRef ? "warn" : undefined,
        statusText: size === undefined ? T("fichier introuvable", "file not found")
          : !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
          : active ? (ready ? T("chargé", "loaded") : T("chargement…", "loading…"))
          : noRef ? T("voix clonée sans enregistrement : choisis un WAV", "cloned voice without a recording: pick a WAV") : undefined,
        values: { ...m } as unknown as Record<string, unknown>,
        editable: true, removable: !active, toggleable: !active || !on,
        ...groupOf(m),
      };
    };
    const refuseActive = (m: Entry, what: { fr: string; en: string }): OpResult | undefined =>
      running.has(m.id) ? { ok: false, text: T(`${m.label} est chargé en ce moment : choisis d'abord une autre voix, puis ${what.fr}.`, `${m.label} is loaded right now: choose another voice first, then ${what.en}.`) } : undefined;
    const problem = (v: ModelValues): Text | undefined => {
      if (!v.label) return T("Donne un nom au modèle.", "Give the model a name.");
      if (!v.model || !existsSync(v.model)) return T(`Fichier introuvable : ${v.model}`, `File not found: ${v.model}`);
      if (v.famille === "autre" && !v.familleAutre) return T("Donne le nom de la famille du modèle.", "Give the model family name.");
      if (v.voix === "clone" && v.refWav && !existsSync(v.refWav)) return T(`Enregistrement introuvable : ${v.refWav}`, `Recording not found: ${v.refWav}`);
      return undefined;
    };

    ctx.items.declare({
      id: "voix-locale", section: "voix", order: 20, offers: "tts",
      label: T("Voix locale (audio.cpp)", "Local voice (audio.cpp)"),
      description: T("Modèles de voix GGUF lancés par audio.cpp sur ce PC, seulement quand ils servent. Un seul chargé à la fois.", "GGUF voice models run by audio.cpp on this PC, only while in use. Only one loaded at a time."),
      addLabel: T("Ajouter un modèle local", "Add a local model"),
      kinds: [KIND],
      list: () => all().map(info),
      add: async (kind, values) => {
        if (kind !== "gguf") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
        const v = clean(values);
        const no = problem(v);
        if (no) return { ok: false, text: no };
        const id = store.add("gguf", v as unknown as Record<string, unknown>, v.label, Object.keys(baseList));
        ctx.items.changed();
        return { ok: true, id, text: T(`${v.label} ajouté. Il n'est pas chargé tout de suite : active-le comme voix quand tu veux.`, `${v.label} added. It isn't loaded right away: activate it as the voice whenever you like.`) };
      },
      update: async (id, values) => {
        const cur = all().find((m) => m.id === id);
        if (!cur) return { ok: false, text: T(`Modèle inconnu : ${id}`, `Unknown model: ${id}`) };
        const v = clean({ ...cur, ...values });
        const no = problem(v);
        if (no) return { ok: false, text: no };
        store.update(id, v as unknown as Record<string, unknown>);
        ctx.items.changed();
        return { ok: true, id, text: running.has(id) ? T(`${v.label} modifié. Les changements s'appliquent au prochain chargement.`, `${v.label} updated. Changes apply on the next load.`) : T(`${v.label} modifié.`, `${v.label} updated.`) };
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
        const v = clean(values);
        const size = sizeOf(v.model);
        if (size === undefined) return { ok: false, text: T(`Fichier introuvable : ${v.model}`, `File not found: ${v.model}`) };
        if (v.voix === "clone") {
          if (!v.refWav) return { ok: false, text: T("Choisis l'enregistrement de la voix (WAV).", "Pick the voice recording (WAV).") };
          if (sizeOf(v.refWav) === undefined) return { ok: false, text: T(`Enregistrement introuvable : ${v.refWav}`, `Recording not found: ${v.refWav}`) };
        }
        const exe = exePath();
        if (!exe) return { ok: false, text: missingExe };
        if (!existsSync(exe)) return { ok: false, text: T(`audio.cpp introuvable : ${exe}`, `audio.cpp not found: ${exe}`) };
        const total = size / 1024 ** 3 + 0.5;
        const cuda = (await backend()) !== "cpu";
        const noText = v.voix === "clone" && !v.refText;
        return { ok: true, text: T(
          `Estimation : ~${total.toFixed(1)} Go ${cuda ? "sur le GPU" : "en mémoire (processeur)"} (modèle ${gb(size)} Go).${noText ? " Sans texte de l'enregistrement, seul le timbre est copié." : ""}`,
          `Estimate: ~${total.toFixed(1)} GB ${cuda ? "on the GPU" : "in memory (CPU)"} (model ${gb(size)} GB).${noText ? " Without the recording's text, only the timbre is copied." : ""}`) };
      },
      action: async (_id, action) => {
        if (action !== "scan") return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
        const norm = (f: string) => f.replace(/\\/g, "/").toLowerCase();
        const known = new Set(all().map((m) => norm(m.model)));
        const found = scanGguf(scanDirs()).filter((f) => !known.has(norm(f)));
        return { ok: true, text: found.length ? T(`${found.length} fichier(s) GGUF trouvé(s) :\n${found.join("\n")}`, `${found.length} GGUF file(s) found:\n${found.join("\n")}`) : T("Aucun nouveau fichier GGUF trouvé.", "No new GGUF file found.") };
      },
    });

    // Modèles à télécharger : un modèle arrive avec ses voix intégrées, une voix par élément (groupées sous le modèle).
    const mine = (k: KnownVoiceModel) => all().filter((m) => samePath(m.model, knownFile(k)));
    const ui = (t: Text) => (typeof t === "string" ? t : (t[ctx.uiLang()] ?? t.fr));
    // Au démarrage aussi : une voix de la puce graphique déjà dans la liste (ajoutée avant cette version de Floppy).
    upgrade();

    modelLibrary(ctx, {
      id: "voix-locale-library", section: "voix", order: 21, offers: "tts",
      label: T("Modèles de voix audio.cpp", "audio.cpp voice models"),
      entries: () => known.map((k) => ({ ...k, needs: voiceNeeds(k) })),
      has: (e) => mine(e as KnownVoiceModel).length > 0,
      itemOf: (e) => mine(e as KnownVoiceModel)[0]?.id,
      missing: () => (exePath() ? undefined : T("Le programme audio.cpp n'est pas encore installé.", "The audio.cpp program is not installed yet.")),
      installed: (e) => {
        const k = e as KnownVoiceModel;
        if (mine(k).length) return;
        for (const v of k.voices) {
          const values = clean({ label: ui(v.label), model: knownFile(k), famille: k.famille, voix: "integree", speaker: v.id, langue: k.langue });
          store.add("gguf", values as unknown as Record<string, unknown>, `${k.id}-${v.id}`, Object.keys(baseList));
        }
        ctx.items.changed();
        upgrade();
      },
      removed: (e) => {
        const list = mine(e as KnownVoiceModel);
        const loaded = list.find((m) => running.has(m.id));
        if (loaded) throw new TextError(T(`${loaded.label} est chargé en ce moment : choisis d'abord une autre voix.`, `${loaded.label} is loaded right now: choose another voice first.`));
        for (const m of list) store.remove(m.id);
        ctx.items.changed();
      },
    });
  },
});
}

export default makePlugin();

/**
 * Format des poids, lu dans le nom du fichier, en court : « q8_0 » → « Q8 », « q4_k_m » → « Q4 », « bf16 » → « BF16 ».
 * undefined : pas d'indice dans le nom.
 */
export function quantOf(path: string): { fr: string; en: string } | undefined {
  const name = path.replace(/^.*[\\/]/, "").replace(/\.gguf$/i, "");
  const m = /(?:^|[-_.])(i?q\d+|bf16|f16|f32)(?:_[0-9a-z]+)*(?=$|[-_.])/i.exec(name);
  if (!m) return undefined;
  const f = m[1]!.toUpperCase();
  return { fr: f, en: f };
}
