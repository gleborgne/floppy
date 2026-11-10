// Ce que partagent les morceaux de la conversation : config, phrases par défaut, un tour, un corps, une initiative.
import { z } from "zod";
import { T } from "@floppy/core";
import type { TurnMode, VoiceStream, WakewordStream, WakewordDetection } from "@floppy/contracts";
import type { BodyState } from "@floppy/protocol";
import { encodeAudioOut } from "@floppy/protocol";
import type { AudioHistory } from "@floppy/core";
import type { SpeechQueue } from "./speech.ts";
import type { LiveConversation } from "./live.ts";
import type { Dictation } from "./dictation.ts";
import type { ReplyFeeler } from "./feel.ts";
import type { SentencePlan } from "./plan.ts";

export const Config = z.object({
  expressiveness: z.enum(["discreet", "natural", "playful"]).default("playful"),
  free_listen_s: z.number().default(8),
  idle_reset_s: z.number().default(300),
  neutral_after_ms: z.number().default(5000),
  /** Phrase dite quand un outil attend l'accord (corps vocal d'origine). Vide : phrase par défaut, dans la langue de l'assistant. */
  approval_prompt: z.string().optional(),
  error_reply: z.string().optional(),
  /** Silence du cerveau (aucun texte, outil ou émotion) au-delà duquel le tour échoue et Floppy le dit. */
  turn_idle_s: z.number().positive().default(300),
  /** Expérimental : en Live, le modèle dit son émotion par un outil (moteurs à appels de fonctions). Désactivé par défaut. */
  live_emotion_tool: z.boolean().default(false),
});

/** Phrases dites par défaut, par langue de l'assistant. */
export const PHRASES = {
  approval_prompt: T("J'ai besoin de ton accord.", "I need your approval."),
  error_reply: T("Désolé, je n'arrive pas à réfléchir pour l'instant.", "Sorry, I can't think right now."),
  error_no_brain: T("Je n'ai aucun cerveau actif. Choisis-en un dans les réglages.", "No brain is active. Choose one in the settings."),
  error_stalled: T("Mon cerveau ne répond plus. Réessaie dans un instant, ou change de cerveau dans les réglages.", "My brain has stopped answering. Try again in a moment, or switch brains in the settings."),
  error_network: T("Je n'arrive pas à joindre le service. Vérifie la connexion, puis réessaie.", "I can't reach the service. Check the connection, then try again."),
  /** Ton par défaut tant que l'utilisateur n'en a pas choisi un. */
  tone: T("cordial et chaleureux", "friendly and warm"),
};
export type Config = z.infer<typeof Config>;

export interface Turn {
  n: number;
  abort: AbortController;
  mode: TurnMode;
  pending: Set<string>;      // phrases envoyées à la synthèse, pas encore finies
  brainDone: boolean;
  spoke: boolean;
  t0: number;
  marks: Record<string, number>;
  /** Mise en scène de chaque phrase du tour, par id de phrase : retirée quand son premier audio arrive (ou à `speak_done`). */
  plans: Map<string, SentencePlan>;
  /** Texte de la réponse reçu du cerveau jusqu'ici (la dernière réponse du corps, terminée ou interrompue). */
  reply: string;
}

/** Silence entre deux paragraphes, comme une respiration. */
export const PARAGRAPH_PAUSE_MS = 450;
/** Coupure de parole : volume baissé le temps de savoir si c'est l'utilisateur ou l'écho de Floppy. */
export const DUCK_MAX_MS = 8000;
/** Après la fin de la parole entendue, attente du texte reconnu avant de remonter le son. */
export const DUCK_WAIT_TRANSCRIPT_MS = 2500;
/** Après la fin de la voix de Floppy, l'écho peut encore arriver (traîne de la pièce + délai du STT). */
export const ECHO_TAIL_MS = 2500;
/** Silence PCM au même débit que le morceau audio qui suit (les 4 premiers octets donnent le débit). */
export function silenceLike(data: Uint8Array, ms: number): Uint8Array {
  const rate = data.byteLength >= 4 ? new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) : 24000;
  return encodeAudioOut(new Int16Array(Math.round((rate || 24000) * ms / 1000)), rate || 24000);
}

export interface Body {
  id: string;
  voice: boolean;
  text: boolean;
  stream?: VoiceStream;
  output?: SpeechQueue;
  history?: AudioHistory;
  live?: LiveConversation;
  wakeStream?: WakewordStream;
  wakeAbort?: AbortController;
  wakeActivation?: WakewordDetection & { expires: number };
  voiceOffset?: number;
  ptt?: boolean;
  /** Dictée en cours : le texte est tapé chez le corps, Floppy ne répond pas. */
  dictation?: Dictation;
  off?: () => void;
  muted: boolean;
  awakeUntil: number;
  lastTurnAt: number;
  turn?: Turn;
  playing: boolean;
  state: BodyState;
  /** Demandes d'accord en cours venant d'un tour de ce corps : parler ne doit pas annuler le tour. */
  awaiting: Set<string>;
  /** Initiative en cours de lecture sur ce corps (hors tour). */
  init?: { id: string; done: boolean };
  /** Réglage en voie rapide en cours (sans tour) : sa demande d'accord doit être dite elle aussi. */
  quick?: boolean;
  /** Début de la parole entendue (VAD) : un hochement de tête quand l'utilisateur fait une pause. */
  speechAt?: number;
  /** La parole en cours a commencé pendant l'écoute libre : sa phrase compte même si elle arrive après la fin de la fenêtre. */
  speechOpen?: boolean;
  /** Phrases envoyées à la voix (récentes) : pour reconnaître leur écho dans le micro. */
  spoken?: { text: string; at: number }[];
  /** Fin de la dernière lecture (message playback:false du corps). */
  playEndAt?: number;
  /** Voix baissée après une possible coupure de parole, en attendant de savoir qui parle. */
  duck?: { timer: NodeJS.Timeout };
  /** Texte complet de la dernière réponse terminée ou interrompue (ni phrase d'attente, ni accord) : pour « répète ». */
  lastReply?: string;
  /** Mode Live : émotion devinée dans ce que dit le modèle. */
  feeler?: ReplyFeeler;
}

export interface Initiative { source: string; text: string; key?: string }
