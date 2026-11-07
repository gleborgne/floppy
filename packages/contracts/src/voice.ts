// Voix : flux micro et voix d'un corps, détecteur de parole, transcription, voix (TTS), mot d'éveil et voix « Live ».
import type { Availability, ToolInfo } from "@floppy/core";

/** Événements d'un flux voix (un corps qui a un micro). */
export type VoiceEvent =
  | { type: "vad"; state: "speech" | "silence" }
  | { type: "merge" }
  | { type: "transcript"; text: string; audio_s: number; stt_ms: number; merged: boolean; utt?: number; /** Silence attendu par le VAD avant la fin (0 en push-to-talk). */ silence_ms?: number; start_sample?: number; end_sample?: number }
  | { type: "barge_in" }
  /** Dictée : hypothèse pour un segment (coupé aux pauses). final : version définitive du segment. */
  | { type: "dictation"; seg: number; text: string; final: boolean }
  | { type: "audio"; id: string; data: Uint8Array }
  | { type: "audio_start"; id: string }
  | { type: "speak_done"; id: string; cancelled: boolean; first_audio_ms?: number; error?: string }
  | { type: "closed" };

export interface VoiceStream {
  /** Audio micro : float32 mono 16 kHz. */
  pushAudio(frame: Float32Array): void;
  /**
   * Dire une phrase (file d'attente). L'audio revient par l'événement `audio` (4 octets taux + PCM int16).
   * Absent : ce flux ne parle pas (écoute seule) ; la voix passe par le service `tts`.
   */
  speak?(id: string, text: string): void;
  /** Vider la file et couper la phrase en cours. */
  cancel(): void;
  /** La voix joue chez le corps : arme l'interruption. */
  setSpeaking(on: boolean): void;
  ptt(on: boolean): void;
  /** Dictée : le texte n'est pas une demande ; il revient en événements `dictation`, sans `transcript`. */
  dictate?(on: boolean): void;
  /** En Live, chaque activation correspond à un seul énoncé local (pas de fusion avec une phrase ignorée). */
  setMergeEnabled?(on: boolean): void;
  on(fn: (ev: VoiceEvent) => void): () => void;
  close(): void;
}

/** Le flux voix d'un corps : écoute (détection de parole, transcription) et, avec une voix locale, parole. */
export interface VoiceService {
  name: string;
  /** Ouvre un flux pour un corps (un id par corps). La voix locale y parle quand un fork « tts » local est en service. */
  open(streamId: string): Promise<VoiceStream>;
}

export interface TtsChunk { rate: number; pcm: Int16Array }

/** Consigne de jeu distincte du texte prononcé ; facultative pour les moteurs sans contrôle expressif. */
export interface SpeechDelivery {
  intent: "explain" | "reassure" | "playful" | "neutral";
  profile: "discreet" | "natural" | "playful";
  language: "fr" | "en";
  tone?: string;
  /** Même émotion que celle envoyée à l'avatar ; le moteur la traduit selon ses capacités. */
  emotion?: string;
  intensity?: number;
}

/** Début ou fin de parole ; sample = index de l'échantillon dans le flux du détecteur (compté depuis open ou reset). */
export interface VadEvent { type: "start" | "end"; sample: number }
export interface VadStream {
  /** Son float32 mono 16 kHz, blocs de toute taille, dans l'ordre. Rend les débuts et fins détectés dans ce bloc. */
  push(frame: Float32Array): VadEvent[];
  /** Oublie l'état (nouvelle écoute) ; le compteur d'échantillons repart de 0. */
  reset(): void;
  close(): void;
}
/** Détecteur de parole en service (l'élément choisi dans le slot listen.vad). Un flux par corps : il a un état. */
export interface VadService {
  name: string;
  /** Silence attendu avant la fin d'une phrase (compté dans la latence perçue). */
  minSilenceMs: number;
  open(): VadStream;
}
/** Transcription en service (l'élément choisi dans le slot listen.stt). Partagée entre les corps. */
export interface SttService {
  name: string;
  /** Langues connues du modèle (« fr », « en »…). Absent : inconnu. */
  languages?: string[];
  /** Un morceau de son float32 mono 16 kHz -> texte. */
  transcribe(audio: Float32Array, opts?: { language?: string; signal?: AbortSignal }): Promise<{ text: string }>;
}


/** Détection locale, indépendante du cerveau et des fournisseurs Live ; audio ou transcriptions existantes. */
export interface WakewordDetection {
  word: string;
  /** Fenêtre audio à rejouer, indices absolus sur le micro mono 16 kHz. Sans indices STT, seule la cascade est autorisée. */
  startSample?: number;
  endSample?: number;
}
export interface WakewordTranscript { text: string; startSample?: number; endSample?: number }
export interface WakewordStream {
  /** Blocs ordonnés ; startSample appartient à l'horloge du corps, pas à celle du moteur. */
  pushAudio(frame: Float32Array, startSample: number): void;
  /** Réutilise la transcription existante ; aucun deuxième flux ni modèle STT. */
  pushTranscript?(transcript: WakewordTranscript): void;
  close(): void;
}
/** Un détecteur du mot d'activation (« Floppy »), sur le son ou sur le texte transcrit. */
export interface WakewordService {
  name: string;
  /** Audio par défaut. Une source transcription attend la phrase avant d'ouvrir Live. */
  input?: "audio" | "transcript";
  words?(): string[];
  availability(): Availability;
  /** Une configuration sauvegardée invalide les détecteurs ouverts. */
  onChange(fn: () => void): () => void;
  open(opts: { body: string; signal: AbortSignal; onDetection(event: WakewordDetection): void; onError(message: string): void }): Promise<WakewordStream>;
}
/** Une voix en service (l'élément choisi dans le slot voice.tts) : moteur ET voix. */
export interface TtsService {
  name: string;
  availability?(): Availability;
  /** Voix locale : elle parle dans le flux du service `voice` (VoiceStream.speak), pas par speak(). */
  viaStream?: boolean;
  speak?(text: string, opts: { signal: AbortSignal; delivery?: SpeechDelivery }): AsyncIterable<TtsChunk>;
}

/** Les blocs sont ordonnés. final et generation_done sont facultatifs dans le protocole
 * fournisseur (GPT Live ne les émet pas) : l'orchestrateur utilise aussi la fin de lecture
 * et des fenêtres de silence bornées. generation désigne une époque de lecture locale. */
export type LiveEvent =
  | { type: "audio"; generation: number; rate: number; pcm: Int16Array }
  | { type: "input_transcript"; text: string; final: boolean; startMs?: number; endMs?: number }
  | { type: "output_transcript"; text: string; final: boolean; /** Même époque que les blocs audio, si connue du fournisseur. */ generation?: number }
  | { type: "interrupted"; generation: number }
  | { type: "generation_done" }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_cancelled"; ids: string[] }
  | { type: "delegation"; id: string; offsetMs: number }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "closed"; reason: string };

export interface LiveSession {
  pushAudio(frame: Float32Array): void;
  /** Demande écrite au modèle à appels de fonctions, équivalente à une entrée vocale. */
  sendText?(text: string): void;
  /** Présent uniquement pour les sessions à appels de fonctions. */
  toolResult?(id: string, name: string, result: { text: string; status: string }): void;
  append(kind: "say" | "think" | "instruct", text: string, delegationId?: string): void;
  close(): Promise<void>;
}
/** Un modèle « Live » qui écoute et parle lui-même (Gemini, GPT) ; les outils passent par lui ou par délégation. */
export interface LiveService {
  name: string;
  availability?(): Availability;
  capabilities: { tools: "function" | "delegation" };
  open(opts: { body: string; instructions: string; tools: ToolInfo[]; signal: AbortSignal; on: (event: LiveEvent) => void }): Promise<LiveSession>;
}

declare module "@floppy/core" {
  interface Services {
    voice: VoiceService;
    tts: TtsService;
    vad: VadService;
    stt: SttService;
    live: LiveService;
    wakeword: WakewordService;
  }
}
