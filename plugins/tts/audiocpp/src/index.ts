// Plugin `tts-audiocpp` : voix locales (audio.cpp, `audiocpp_server.exe`), comme llama.cpp mais pour le son.
// - Le plugin tient le catalogue des modèles (fenêtre des réglages, Voix) et offre le service `tts` modèle par modèle.
// - Chaque modèle choisi tourne dans un fork : le serveur vit et meurt avec lui. max 1 : un seul modèle dans la mémoire du GPU.
// - Le fork écrit son dossier de travail (server.json + voices/), lance le serveur, attend qu'il réponde, puis parle en flux (SSE).
import { z } from "zod";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { definePlugin, modelLibrary, programLibrary, restartsModels, failoverText, type ProgramBuild, findExe, httpHealthy, startLocalServer, scanGguf as scanAll, Pcm16Decoder, pcmWav, wavPcm, wavDataUrl, wavFromDataUrl, TextError, type Context, type FieldDef, type ItemInfo, type ItemKind, type ModelNeeds, type OpResult, type Text } from "@floppy/core";
import type { TtsChunk, TtsService } from "@floppy/contracts";

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

/** Familles qui savent cloner une voix à partir d'un enregistrement. */
export const CLONERS = ["qwen3_tts", "voxcpm2", "pocket_tts"];

/**
 * Le modèle sait cloner une voix. Chez Qwen3-TTS, seule la variante « Base » clone : « CustomVoice » n'a que ses voix
 * intégrées (audio.cpp répond « prefill requires speaker ») et « VoiceDesign » invente une voix d'après une description.
 * La variante se lit dans le nom du fichier.
 */
export function clones(m: Pick<ModelValues, "famille" | "familleAutre" | "model">): boolean {
  if (!CLONERS.includes(familyOf(m as ModelValues))) return false;
  return !/custom[-_ ]?voice|voice[-_ ]?design/i.test(basename(m.model.replace(/\\/g, "/")));
}
/** Familles qui lisent le texte de l'enregistrement (sinon : seulement le timbre, x_vector_only_mode). */
const WITH_TEXT = ["qwen3_tts", "voxcpm2"];

/**
 * Phrases à lire au micro : 15 à 20 s à voix normale (une cinquantaine de mots), des sons variés. Plus courtes, une
 * lecture rapide passe sous les 10 s une fois les silences des bords coupés.
 */
export const PROMPTS: Text[] = [
  T("Le matin, j'aime ouvrir la fenêtre et écouter la ville se réveiller. Les volets claquent, un vélo passe, et quelqu'un rit au coin de la rue. Ensuite, je prépare un café bien chaud, je regarde le ciel, et je me demande tranquillement ce que la journée va m'apporter.",
    "In the morning, I like to open the window and listen to the city waking up. Shutters bang, a bike goes by, and someone laughs around the corner. Then I make a hot cup of coffee, look at the sky, and quietly wonder what the day is going to bring me."),
  T("Hier soir, nous avons préparé une grande soupe de légumes. Il y avait des carottes, des poireaux, deux pommes de terre et beaucoup trop de poivre ! Mon frère a toussé pendant cinq minutes, puis il a ri si fort que toute la table a fini par rire avec lui.",
    "Last night, we made a big vegetable soup. There were carrots, leeks, two potatoes and far too much pepper! My brother coughed for five long minutes, then he laughed so hard that the whole table ended up laughing with him, even my grandmother, who never laughs at dinner."),
  T("Pour aller à la gare, prends la deuxième rue à gauche, traverse le petit pont, puis continue tout droit jusqu'à la boulangerie. Là, tourne à droite et marche encore deux cents mètres. Si tu vois la fontaine et le vieux kiosque à journaux, c'est que tu es presque arrivé.",
    "To get to the station, take the second street on the left, cross the little bridge, then keep going straight to the bakery. There, turn right and walk another two hundred meters. If you see the fountain and the old newspaper stand, you are almost there."),
  T("Tu sais quoi ? Je crois que le chat a encore caché mes clés sous le canapé. Il fait ça chaque fois que je suis pressé. Ce matin, j'ai cherché partout : dans la cuisine, dans mes poches, et même dans le frigo. Finalement, il me regardait, très fier de lui.",
    "You know what? I think the cat hid my keys under the sofa again. He does that every time I'm in a hurry. This morning, I looked everywhere: in the kitchen, in my pockets, and even in the fridge. In the end, he was just watching me, very proud of himself."),
  T("Quand la pluie s'arrête enfin, l'air sent la terre mouillée, et les enfants sortent sauter dans toutes les flaques du jardin. Les oiseaux recommencent à chanter, le soleil revient doucement entre les nuages, et les grands ouvrent les fenêtres pour laisser entrer un peu de fraîcheur.",
    "When the rain finally stops, the air smells of wet earth, and the children run out to jump in every puddle in the garden. The birds start singing again, the sun slowly comes back between the clouds, and the grown-ups open the windows to let in some fresh air."),
];

/** Phrase d'essai proposée dans le formulaire d'une voix. */
const TRIAL = T("Bonjour ! Je suis Floppy. Tu veux que je lise tes mails du jour ?", "Hello! I'm Floppy. Do you want me to read today's emails?");

/**
 * Formulaire d'une voix : son nom, son enregistrement, ce qu'il dit, et le modèle qui la fait parler.
 * lang : langue de la fenêtre (la phrase d'essai est déjà écrite, dans cette langue).
 */
export function voiceKind(models: { value: string; label: Text }[], lang: "fr" | "en" = "fr"): ItemKind {
  return {
    id: "voice",
    label: T("Nouvelle voix", "New voice"),
    description: T("Quelques secondes de ta voix (ou d'une autre), enregistrées au micro ou importées. Elle pèse quelques centaines de Ko : le modèle, lui, est partagé.",
      "A few seconds of your voice (or another one), recorded with the microphone or imported. It weighs a few hundred KB: the model is shared."),
    fields: [
      { key: "label", label: T("Nom de la voix", "Voice name"), type: "text", required: true, placeholder: T("Ma voix", "My voice"),
        hint: T("C'est aussi le nom à dire : « Floppy, prends ma voix ».", "It's also the name to say: \"Floppy, use my voice\".") },
      { key: "sample", label: T("Enregistrement", "Recording"), type: "audio", required: true, prompts: PROMPTS, textKey: "refText", seconds: { min: 10, max: 20 } },
      { key: "refText", label: T("Ce que dit l'enregistrement", "What the recording says"), type: "textarea",
        hint: T("La phrase lue. Si tu as dit autre chose, corrige-la ici. Vide : seul le timbre est copié.", "The sentence read. If you said something else, fix it here. Empty: only the timbre is copied.") },
      { key: "model", label: T("Modèle qui la fait parler", "Model that speaks it"), type: "select", required: true, options: models,
        hint: T("Qwen3 TTS Base : plus fidèle, carte graphique. Pocket TTS : plus rapide, processeur. (Qwen3 CustomVoice ne sait pas cloner.)", "Qwen3 TTS Base: more faithful, graphics card. Pocket TTS: faster, processor. (Qwen3 CustomVoice cannot clone.)") },
      { key: "essai", label: T("Phrase d'essai", "Test sentence"), type: "text", default: TRIAL[lang] },
    ],
  };
}

function sizeOf(file: string): number | undefined {
  try { return statSync(file).size; } catch { return undefined; }
}
const gbNum = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const gb = (bytes: number) => String(gbNum(bytes)).replace(".", ",");

/** Fichiers .gguf des dossiers (lecture commune du noyau), les noms de voix d'abord. */
export function scanGguf(dirs: string[], max = 60): string[] {
  const voice = (p: string) => (/tts|voxcpm|kokoro/i.test(basename(p)) ? 0 : 1);
  return scanAll(dirs, max).sort((a, b) => voice(a) - voice(b));
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
    /** Voix clonée posée sur un modèle qui ne sait pas cloner (ex. Qwen3 CustomVoice). */
    const noClone = (file: string): Text => {
      const name = basename(file.replace(/\\/g, "/"));
      return T(`${name} ne sait pas cloner une voix. L'enregistrement est gardé : change seulement « Modèle qui la fait parler » (Qwen3 TTS Base ou Pocket TTS).`,
        `${name} cannot clone a voice. The recording is kept: just change “Model that speaks it” (Qwen3 TTS Base or Pocket TTS).`);
    };
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
      if (e.voix === "clone" && !clones(e)) throw new TextError(noClone(e.model));
      if (await httpHealthy(base)) throw new TextError(T(`le port ${cfg.port} est déjà pris par un autre serveur : arrête-le d'abord (ou change le port)`, `port ${cfg.port} is already taken by another server: stop it first (or change the port)`));
      const dir = join(f.home, "tts-audiocpp", e.id);
      mkdirSync(dir, { recursive: true });
      const file = prepareDir(dir, e, { ...cfg, backend: await backend() });
      f.log("info", `lancement d'audio.cpp : ${e.label}`, { model: e.model });
      const exe = exePath();
      if (!exe) throw new TextError(missingExe);
      // Le serveur est arrêté avec le fork ; une panne une fois prêt met la voix en panne (le noyau la relance).
      f.effect(await startLocalServer(f, {
        name: "audio.cpp", exe, args: ["--config", file], base, cwd: dirname(exe), stdout: true, tailLines: 3,
        startTimeout_s: cfg.startTimeout_s, onCrash: (why) => f.fail(why),
      }));
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
      startTimeout_s: cfg.startTimeout_s + 60,
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
    /** Nom d'un fichier de modèle : celui du catalogue des modèles connus, sinon le nom du fichier. */
    const modelLabel = (file: string): Text => known.find((x) => samePath(knownFile(x), file))?.label ?? basename(file);
    /**
     * Chaque voix est rangée sous son modèle (le fichier GGUF) : la fenêtre montre les voix, puis les modèles avec leur
     * taille. La taille est celle du modèle, partagée par ses voix : elle n'apparaît que sur le modèle.
     */
    const groupOf = (m: Entry): Pick<ItemInfo, "group"> => {
      if (!m.model) return {};
      const size = sizeOf(m.model);
      const q = quantOf(m.model);
      const where = voiceNeeds({ famille: familyOf(m) as KnownVoiceModel["famille"] }).device === "gpu" ? T("carte graphique", "graphics card") : T("processeur", "processor");
      const detail = size === undefined ? T("fichier introuvable", "file not found")
        : T(`${gb(size)} Go · ${q ? `${q.fr} · ` : ""}${where.fr}`, `${gb(size)} GB · ${q ? `${q.en} · ` : ""}${where.en}`);
      return { group: { id: m.model.replace(/\\/g, "/").toLowerCase(), label: modelLabel(m.model), detail } };
    };
    /** Durée d'un enregistrement (s), gardée tant que le fichier ne change pas : la liste est relue souvent. */
    const durations = new Map<string, { mtime: number; seconds: number }>();
    const secondsOf = (file: string): number | undefined => {
      try {
        const mtime = statSync(file).mtimeMs;
        const c = durations.get(file);
        if (c?.mtime === mtime) return c.seconds;
        const w = wavPcm(new Uint8Array(readFileSync(file)));
        const seconds = w.pcm.length / w.rate;
        durations.set(file, { mtime, seconds });
        return seconds;
      } catch { return undefined; }
    };
    const info = (m: Entry): ItemInfo => {
      const size = sizeOf(m.model);
      const ready = running.get(m.id);
      const active = ready !== undefined;
      const on = store.isEnabled(m.id);
      const clone = m.voix === "clone";
      const noRef = clone && !m.refWav;
      const cantClone = clone && !clones(m);
      const secs = clone && m.refWav ? secondsOf(m.refWav) : undefined;
      const ml = modelLabel(m.model);
      const mlFr = typeof ml === "string" ? ml : ml.fr, mlEn = typeof ml === "string" ? ml : ml.en;
      const detail = !clone
        ? T(`voix intégrée${m.speaker ? ` (${m.speaker})` : ""} · ${mlFr}`, `built-in voice${m.speaker ? ` (${m.speaker})` : ""} · ${mlEn}`)
        : T(`voix clonée${secs ? ` · ${Math.round(secs)} s d'enregistrement` : ""} · parle avec ${mlFr}`, `cloned voice${secs ? ` · ${Math.round(secs)} s recording` : ""} · speaks with ${mlEn}`);
      return {
        id: m.id, label: m.label, enabled: on, active, kind: clone ? "voice" : "gguf",
        detail: size === undefined ? T(`fichier du modèle introuvable · ${detail.fr}`, `model file not found · ${detail.en}`) : detail,
        status: size === undefined || cantClone ? "error" : !on ? "off" : active ? (ready ? "ok" : "loading") : noRef ? "warn" : undefined,
        statusText: size === undefined ? T("fichier introuvable", "file not found")
          : cantClone ? noClone(m.model)
          : !on ? T("désactivé : Floppy ne le voit plus", "disabled: Floppy no longer sees it")
          : active ? (ready ? T("chargé", "loaded") : T("chargement…", "loading…"))
          : noRef ? T("voix clonée sans enregistrement : enregistre-la", "cloned voice without a recording: record it") : undefined,
        // sample : l'enregistrement, pour le formulaire d'une voix (son chemin ; un nouvel enregistrement le remplace).
        values: { ...m, ...(clone ? { sample: m.refWav } : {}) } as unknown as Record<string, unknown>,
        editable: true, removable: true, toggleable: !active || !on,
        ...(clone && secs !== undefined ? { actions: [{ id: "listen", label: T("Écouter", "Listen"), play: true }] } : {}),
        ...groupOf(m),
      };
    };

    // ---- Voix créées dans la fenêtre : l'enregistrement est copié chez Floppy (l'original peut disparaître).
    const voicesDir = join(ctx.home, "tts-audiocpp", "voices");
    /** Modèles qui savent cloner, un par fichier : les choix du formulaire d'une voix. */
    const cloneModels = (): { value: string; label: Text }[] => {
      const out: { value: string; label: Text }[] = [];
      for (const m of all()) if (clones(m) && m.model && !out.some((o) => samePath(o.value, m.model))) out.push({ value: m.model, label: modelLabel(m.model) });
      return out;
    };
    /** Valeurs d'une voix (formulaire) -> entrée : le modèle choisi garde sa famille et son mode. */
    const voiceEntry = (values: Record<string, unknown>, cur?: ModelValues): { v: ModelValues; wav?: Uint8Array } => {
      const wav = wavFromDataUrl(values.sample);
      const model = str(values.model) || cur?.model || "";
      const twin = all().find((m) => samePath(m.model, model));
      const v = clean({
        ...(cur ?? {}), ...(twin ? { famille: twin.famille, familleAutre: twin.familleAutre, mode: twin.mode, rate: twin.rate } : {}),
        label: values.label ?? cur?.label, model, voix: "clone",
        refWav: wav ? "" : str(values.sample) || cur?.refWav || "",
        refText: typeof values.refText === "string" ? values.refText : cur?.refText ?? "",
      } as Record<string, unknown>);
      return { v, ...(wav ? { wav } : {}) };
    };
    const saveSample = (wav: Uint8Array): string => {
      mkdirSync(voicesDir, { recursive: true });
      const file = join(voicesDir, `${randomUUID()}.wav`);
      writeFileSync(file, wav);
      return file;
    };
    const voiceProblem = (v: ModelValues, wav?: Uint8Array): Text | undefined => {
      if (!v.label) return T("Donne un nom à la voix.", "Give the voice a name.");
      if (!v.model) return T("Choisis le modèle qui la fait parler. Aucun ? Télécharge d'abord Qwen3 TTS ou Pocket TTS.", "Choose the model that speaks it. None? Download Qwen3 TTS or Pocket TTS first.");
      if (!existsSync(v.model)) return T(`Fichier du modèle introuvable : ${v.model}`, `Model file not found: ${v.model}`);
      if (!clones(v)) return noClone(v.model);
      if (!wav && !v.refWav) return T("Enregistre la voix, ou importe un fichier.", "Record the voice, or import a file.");
      if (!wav && !existsSync(v.refWav)) return T(`Enregistrement introuvable : ${v.refWav}`, `Recording not found: ${v.refWav}`);
      return undefined;
    };

    /**
     * Essai d'une voix avec le modèle chargé en ce moment (le serveur ne garde qu'un modèle). L'enregistrement part en
     * voice_ref : pas besoin de relancer le serveur. Rien de chargé : on explique comment l'entendre.
     */
    const trialVoice = async (values: Record<string, unknown>, id?: string): Promise<OpResult> => {
      const cur = id ? all().find((m) => m.id === id) : undefined;
      const { v, wav } = voiceEntry(values, cur);
      if (!wav && !(v.refWav && existsSync(v.refWav))) return { ok: false, text: T("Enregistre la voix d'abord.", "Record the voice first.") };
      const loadedId = [...running].find(([, ok]) => ok)?.[0];
      const loaded = loadedId ? all().find((m) => m.id === loadedId) : undefined;
      if (!loaded || !(await httpHealthy(base))) return { ok: true, text: T("Aucune voix audio.cpp n'est chargée en ce moment. Garde la voix puis choisis-la : Floppy charge son modèle (environ 20 s), et tu l'entends.", "No audio.cpp voice is loaded right now. Keep the voice and choose it: Floppy loads its model (about 20 s), and you hear it.") };
      const fam = familyOf(loaded);
      const name = modelLabel(loaded.model);
      const nameFr = typeof name === "string" ? name : name.fr, nameEn = typeof name === "string" ? name : name.en;
      if (!clones(loaded)) return { ok: true, text: T(`Le modèle chargé (${nameFr}) ne sait pas cloner une voix, donc l'essai est impossible maintenant. Garde la voix puis choisis-la : Floppy charge son modèle, et tu l'entends.`, `The loaded model (${nameEn}) cannot clone a voice, so a trial is not possible right now. Keep the voice and choose it: Floppy loads its model, and you hear it.`) };
      let ref = v.refWav;
      if (wav) { mkdirSync(join(ctx.home, "tts-audiocpp"), { recursive: true }); ref = join(ctx.home, "tts-audiocpp", "essai.wav"); writeFileSync(ref, wav); }
      const text = str(values.essai) || TRIAL[ctx.uiLang() === "en" ? "en" : "fr"];
      const streaming = loaded.mode === "streaming";
      const r = await fetch(`${base}/v1/audio/speech`, {
        method: "POST", signal: AbortSignal.timeout(120_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL_ID, input: text, voice_ref: slash(ref), language: loaded.langue || ctx.assistant.language,
          ...(WITH_TEXT.includes(fam) ? (v.refText ? { reference_text: v.refText.replace(/\s*[\r\n]+\s*/g, " ") } : { options: { x_vector_only_mode: true } }) : {}),
          ...(streaming ? { stream_format: "sse" } : { response_format: "wav" }),
        }),
      });
      if (!r.ok || !r.body) {
        const why = (await r.text().catch(() => "")).slice(0, 200);
        return { ok: false, text: T(`La voix locale a répondu ${r.status} : ${why}`, `The local voice answered ${r.status}: ${why}`) };
      }
      let out: Uint8Array;
      if (streaming) {
        const parts: Int16Array[] = [];
        for await (const pcm of ssePcm(r.body)) parts.push(pcm);
        const all16 = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { all16.set(p, o); o += p.length; }
        out = pcmWav(rateOf(loaded), all16);
      } else out = new Uint8Array(await r.arrayBuffer());
      return { ok: true, text: T(`Essai avec ${nameFr} (le modèle chargé).`, `Trial with ${nameEn} (the loaded model).`), audio: wavDataUrl(out) };
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
      // Relus à chaque fois : les modèles qui clonent changent quand on en télécharge un.
      get kinds() { return [voiceKind(cloneModels(), ctx.uiLang() === "en" ? "en" : "fr"), KIND]; },
      list: () => all().map(info),
      add: async (kind, values) => {
        if (kind === "voice") {
          const { v, wav } = voiceEntry(values);
          const no = voiceProblem(v, wav);
          if (no) return { ok: false, text: no };
          const ready = { ...v, refWav: wav ? saveSample(wav) : v.refWav };
          const id = store.add("voice", ready as unknown as Record<string, unknown>, v.label, Object.keys(baseList));
          ctx.items.changed();
          return { ok: true, id, text: T(`${v.label} gardée. Choisis-la comme voix quand tu veux.`, `${v.label} kept. Choose it as the voice whenever you like.`) };
        }
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
        // Formulaire d'une voix (champ « sample ») : un nouvel enregistrement remplace l'ancien.
        if ("sample" in values) {
          const { v, wav } = voiceEntry(values, cur);
          const no = voiceProblem(v, wav);
          if (no) return { ok: false, text: no };
          const old = cur.refWav;
          const next = { ...v, refWav: wav ? saveSample(wav) : v.refWav };
          store.update(id, next as unknown as Record<string, unknown>);
          // L'ancien enregistrement n'est effacé que s'il était à Floppy (jamais un fichier de l'utilisateur).
          if (wav && old && samePath(dirname(old), voicesDir)) rmSync(old, { force: true });
          ctx.items.changed();
          return { ok: true, id, text: running.has(id) ? T(`${v.label} modifiée. Les changements s'appliquent au prochain chargement.`, `${v.label} updated. Changes apply on the next load.`) : T(`${v.label} modifiée.`, `${v.label} updated.`) };
        }
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
        // Un enregistrement fait dans Floppy part avec la voix ; un fichier de l'utilisateur n'est jamais effacé.
        if (cur.refWav && samePath(dirname(cur.refWav), voicesDir)) rmSync(cur.refWav, { force: true });
        ctx.items.changed();
        return { ok: true, text: T(`${cur.label} supprimé de la liste (le fichier du modèle n'est pas touché).`, `${cur.label} removed from the list (the model file isn't touched).`) };
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
      test: async (kind, values, id) => {
        if (kind === "voice") return trialVoice(values, id);
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
      action: async (id, action) => {
        if (action === "listen") {
          const cur = all().find((m) => m.id === id);
          if (!cur?.refWav || !existsSync(cur.refWav)) return { ok: false, text: T("Enregistrement introuvable.", "Recording not found.") };
          return { ok: true, text: T(`${cur.label} : l'enregistrement.`, `${cur.label}: the recording.`), audio: wavDataUrl(new Uint8Array(readFileSync(cur.refWav))) };
        }
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
