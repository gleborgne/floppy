// Protocole noyau <-> corps (v0). Partagé par le noyau, l'app Electron et les futurs corps (Reachy, Telegram…).
// Transports : MessagePort (corps par défaut, dans l'app) ou WebSocket 127.0.0.1 (autres corps).
// Les messages texte sont du JSON. L'audio passe en binaire (voir AUDIO_*).

export const PROTOCOL_VERSION = 0;

// Normalisation de texte (accents, casse, ponctuation), partagée par le noyau et les plugins.
import { fold } from "./text.ts";
export { stripAccents, fold, foldTokens, wordsKey, slugify } from "./text.ts";

// ------------------------------------------------------------------ Émotions
/**
 * Émotions pilotées par le noyau. Chaque corps les rend à sa façon :
 * l'avatar Electron par la forme des yeux et de la bouche, Reachy par la tête et les antennes.
 * Les noms sont stables (anglais) ; le cerveau utilise les mots français de EMOTION_WORDS_FR.
 */
export const EMOTIONS = [
  "neutral", "happy", "joy", "laugh", "love", "excited", "proud",
  "sad", "cry", "angry", "annoyed", "scared", "surprised", "shocked",
  "confused", "skeptical", "mischief", "wink", "shy", "bored", "tired", "sleepy",
  "thinking", "curious", "focused", "sorry", "relieved", "determined",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Mots que le cerveau peut écrire au début d'une réponse : « [joie] Bonne nouvelle… ». */
export const EMOTION_WORDS_FR: Record<string, Emotion> = {
  neutre: "neutral", content: "happy", joie: "joy", rire: "laugh", amour: "love", excite: "excited", fier: "proud",
  triste: "sad", pleure: "cry", colere: "angry", agace: "annoyed", peur: "scared", surpris: "surprised", choque: "shocked",
  perplexe: "confused", sceptique: "skeptical", malicieux: "mischief", clin: "wink", timide: "shy", ennui: "bored",
  fatigue: "tired", endormi: "sleepy", reflechit: "thinking", curieux: "curious", concentre: "focused",
  desole: "sorry", soulage: "relieved", determine: "determined",
};

/** Liste courte donnée au cerveau dans son prompt (pas tout : un petit modèle s'y perd). */
export const PROMPT_EMOTIONS_FR = ["content", "joie", "rire", "amour", "fier", "triste", "desole", "surpris", "perplexe", "malicieux", "curieux", "agace"];

export function normWord(w: string): string {
  return fold(w).replace(/[^a-z]/g, "");
}

export function emotionFromWord(w: string): Emotion | undefined {
  const n = normWord(w);
  if ((EMOTIONS as readonly string[]).includes(n)) return n as Emotion;
  return EMOTION_WORDS_FR[n];
}

/**
 * Intensité d'une émotion : 0 (à peine) … 1 (normale) … 1.25 (forte). Sans intensité, un corps prend 1.
 * Le cerveau la donne dans l'étiquette : « [joie+] » forte, « [content-] » légère, « [très surpris] », « [un peu triste] ».
 */
export const INTENSITY_STRONG = 1.25;
export const INTENSITY_LIGHT = 0.45;

/** Lit une étiquette d'émotion (sans les crochets) : mot, et intensité éventuelle. */
export function parseEmotionTag(raw: string): { emotion: Emotion; intensity?: number } | undefined {
  let w = fold(raw.trim());
  let intensity: number | undefined;
  if (/\+\s*$/.test(w)) { intensity = INTENSITY_STRONG; w = w.replace(/\+\s*$/, ""); }
  else if (/-\s*$/.test(w)) { intensity = INTENSITY_LIGHT; w = w.replace(/-\s*$/, ""); }
  const strong = w.match(/^(tres|super|trop|vraiment)\s+(.+)$/);
  const light = w.match(/^(un peu|peu|legerement|assez)\s+(.+)$/);
  if (strong) { intensity = INTENSITY_STRONG; w = strong[2]!; }
  else if (light) { intensity = INTENSITY_LIGHT; w = light[2]!; }
  const emotion = emotionFromWord(w);
  if (!emotion) return undefined;
  return intensity === undefined ? { emotion } : { emotion, intensity };
}

// ------------------------------------------------------------------ Humeur
/**
 * Humeur : le fond émotionnel, qui change lentement (le noyau l'envoie après chaque changement net).
 * valence : -1 (morose) … 0 (neutre) … 1 (joyeux). énergie : 0 (épuisé, va s'endormir) … 1 (plein d'entrain).
 * Un corps la montre quand aucune émotion n'est en cours, à la place du visage neutre.
 */
export interface Mood { valence: number; energy: number }

/** Petits signaux de conversation, sans émotion : hocher la tête quand on vous parle, sursauter au réveil. */
export const CUES = ["nod", "perk", "startle", "wake"] as const;
export type Cue = (typeof CUES)[number];

/** Intention gestuelle d'une phrase ; le corps reste libre de sa mise en scène. */
export type SpeechGesture = "explain" | "playful" | "question" | "none";

// ------------------------------------------------------------------ États
export const STATES = ["sleep", "idle", "listening", "thinking", "speaking"] as const;
export type BodyState = (typeof STATES)[number];

// ------------------------------------------------------------------ Capacités d'un corps
/**
 * `panel` : le corps sait ouvrir une fenêtre de résultats décrite en A2UI (voir docs/spec/a2ui.md).
 * `document` : le corps sait afficher un document Markdown (fenêtre « Documents » avec la liste des anciens).
 * `choice` : le corps sait montrer une liste d'options et rendre celle que l'utilisateur choisit (choice.request).
 */
export const CAPABILITIES = ["voice", "text", "voice_note", "display", "emotion", "gesture", "approval", "panel", "document", "speech_timing", "choice"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Une option d'un choix dans une liste (choice.request) : textes déjà dans la langue de l'assistant. */
export interface ChoiceOption { id: string; label: string; detail?: string }

/** Une ligne de la liste des documents (date ISO). */
export interface DocumentEntry { id: string; title: string; date: string; tags: string[] }

export interface BodyToolDecl {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  level: "read" | "write" | "send" | "delete" | "physical";
}

// ------------------------------------------------------------------ Corps -> noyau
export type BodyToKernel =
  /** managed : corps branché par un plugin qui le liste lui-même dans les réglages (ex. Reachy) : le hub ne le relist pas. */
  | { type: "hello"; id: string; name: string; version: string; capabilities: Capability[]; tools?: BodyToolDecl[]; token?: string; managed?: boolean }
  | { type: "text"; text: string }                         // message tapé (corps texte : chat, Telegram)
  | { type: "ptt"; on: boolean }                           // parler (raccourci clavier)
  | { type: "dictate"; on: boolean }                       // dictée : le texte est tapé dans la fenêtre active, sans réponse
  | { type: "mute"; on: boolean }                          // « dors » / réveil
  | { type: "listen.stop" }                               // fin de l'écoute active, sans mise en veille
  | { type: "approval.response"; id: string; ok: boolean }
  /** L'utilisateur a choisi une option (son id) dans la liste d'un choice.request. */
  | { type: "choice.response"; id: string; option: string }
  | { type: "tool.result"; callId: string; ok: boolean; text: string }
  | { type: "document.open"; id: string }                // l'utilisateur choisit un ancien document dans la liste
  /** L'utilisateur supprime un document de la liste. current : le document affiché (s'il est supprimé, on montre le suivant). */
  | { type: "document.delete"; id: string; current?: string }
  | { type: "playback"; playing: boolean };                // la voix joue (true) ou la file audio est vide (false)

// ------------------------------------------------------------------ Noyau -> corps
export type KernelToBody =
  | { type: "welcome"; protocol: number; assistant: { name: string; language: string } }
  | { type: "state"; state: BodyState }
  /** intensity : voir parseEmotionTag (1 sans valeur). ms : durée, puis retour à l'humeur. */
  | { type: "emotion"; emotion: Emotion; intensity?: number; ms?: number; /** Corps speech_timing : début du prochain bloc audio, après les blocs déjà en file. */ nextAudio?: string }
  /** Pour le corps vocal d'origine avec speech_timing, juste avant le premier bloc de la phrase. */
  | { type: "speech.gesture"; intent: SpeechGesture; intensity: number; nextAudio: string }
  /** Humeur de fond (voir Mood), envoyée aux corps qui ont `emotion`. */
  | { type: "mood"; valence: number; energy: number }
  /** Signal bref (voir CUES) : hochement pendant l'écoute, etc. Envoyé aux corps qui ont `emotion`. */
  | { type: "cue"; cue: Cue }
  | { type: "transcript"; text: string; final: boolean }
  /** Dictée : effacer `del` caractères puis taper `ins` dans la fenêtre active (mots confirmés seulement). */
  | { type: "dictation"; del: number; ins: string }
  | { type: "reply.delta"; text: string }
  | { type: "reply.done"; text: string }
  | { type: "interrupt" }
  /** Voix baissée (on: true) ou remise à son volume (on: false) : coupure de parole possible, en attente du texte reconnu. */
  | { type: "duck"; on: boolean }
  /** origin : corps d'origine du tour qui demande (un corps distant, comme Telegram, ne montre que les siennes). */
  | { type: "approval.request"; id: string; tool: string; summary: string; level: string; ttl_s: number; origin?: string }
  | { type: "approval.closed"; id: string; ok: boolean }
  /** Choix dans une liste : une seule option à rendre (choice.response) avant ttl_s secondes. Corps qui ont `choice`. */
  | { type: "choice.request"; id: string; title: string; options: ChoiceOption[]; ttl_s: number; origin?: string }
  /** Choix fermé (réponse, délai, annulation) : le corps retire la liste. picked : l'option retenue, absente sinon. */
  | { type: "choice.closed"; id: string; picked?: string }
  | { type: "tool.call"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "card"; title: string; lines: string[] }
  /** Fenêtre de résultats : messages A2UI (surfaceUpdate, beginRendering). Un même id remplace la fenêtre. */
  | { type: "panel"; id: string; title: string; a2ui: unknown[] }
  /** Document Markdown à afficher. entries : les documents récents (barre de gauche). */
  | { type: "document"; id: string; title: string; markdown: string; entries?: DocumentEntry[] }
  /** Nouvelle liste des documents (après une suppression) ; le document affiché ne change pas. */
  | { type: "documents"; entries: DocumentEntry[] }
  | { type: "notify"; text: string; important: boolean }
  | { type: "error"; text: string };

// ------------------------------------------------------------------ Audio (binaire)
/** Micro : float32 mono 16 kHz, trames de taille libre (512 conseillé). */
export const AUDIO_IN_RATE = 16000;
/** Voix : en-tête 4 octets (taux d'échantillonnage, uint32 little-endian) + PCM int16 mono. */
export function encodeAudioOut(pcm: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(4 + pcm.byteLength);
  new DataView(out.buffer).setUint32(0, rate, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 4);
  return out;
}
export function decodeAudioOut(buf: ArrayBuffer | Uint8Array): { rate: number; pcm: Int16Array } {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const rate = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  const copy = u8.slice(4);
  return { rate, pcm: new Int16Array(copy.buffer, 0, copy.byteLength >> 1) };
}

/** Un transport de corps : MessagePort, WebSocket, adaptateur (Reachy, Telegram). */
export interface BodyTransport {
  send(msg: KernelToBody): void;
  sendAudio(data: Uint8Array): void;
  onMessage(fn: (msg: BodyToKernel) => void): void;
  onAudio(fn: (frame: Float32Array) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}
