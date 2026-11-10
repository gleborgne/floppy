// Le plan d'une phrase dite : tout ce qu'il faut pour la mettre en scène, calculé une fois quand elle part à la
// synthèse (voir `planSentence`) et consommé quand son premier bloc audio arrive (voir voice-events.ts, « audio »).
// Ordre de jeu à ce moment-là : silence de paragraphe, émotion, geste, puis le bloc audio.
import { type SpeechDelivery } from "@floppy/contracts";
import { emotionInfo, expressivenessFactor } from "@floppy/toolkit";
import type { Emotion, SpeechGesture } from "@floppy/protocol";
import { sentenceGesture } from "./gesture.ts";
import type { Settled } from "./settle.ts";
import { spokenForm } from "./spoken-form.ts";

export interface SentencePlan {
  text: string;
  /** Émotion de la phrase (voix, geste) ; absente : jeu neutre. */
  emotion?: string;
  intensity?: number;
  /** Expression montrée quand l'audio de la phrase commence ; absente : le visage ne change pas. */
  cue?: { emotion: Emotion; intensity?: number };
  /** Simple apaisement de l'émotion précédente : ne pousse pas l'humeur. */
  settling?: boolean;
  gesture: { intent: SpeechGesture; intensity: number };
  /** La phrase ouvre un paragraphe : un silence est joué juste avant elle. */
  pauseBefore: boolean;
  /** Ce que reçoit la voix. */
  delivery: SpeechDelivery;
}

/** Ce que reçoit la voix pour une phrase : intention tirée de la fiche des émotions, profil, langue, ton. */
export function deliveryFor(o: { emotion?: string; intensity?: number; profile: SpeechDelivery["profile"]; language: "fr" | "en"; tone: string }): SpeechDelivery {
  const intent = emotionInfo(o.emotion)?.intent ?? "neutral";
  return { intent, profile: o.profile, language: o.language, tone: o.tone,
    ...(o.emotion ? { emotion: o.emotion } : {}), ...(o.intensity === undefined ? {} : { intensity: o.intensity }) };
}

/** Plan d'une phrase. `settled` : ce que donne `EmotionSettler.next` ; `request` : ce que l'utilisateur a demandé. */
export function planSentence(o: { text: string; settled: Settled; paragraph: boolean; request: string; profile: SpeechDelivery["profile"]; language: "fr" | "en"; tone: string }): SentencePlan {
  const { settled } = o;
  return {
    text: spokenForm(o.text, o.language), // la voix lit la forme parlée ; le geste se juge sur le texte écrit
    ...(settled.emotion === undefined ? {} : { emotion: settled.emotion }),
    ...(settled.intensity === undefined ? {} : { intensity: settled.intensity }),
    ...(settled.cue ? { cue: { emotion: settled.cue.emotion as Emotion, ...(settled.cue.intensity === undefined ? {} : { intensity: settled.cue.intensity }) } } : {}),
    ...(settled.cue && settled.settling ? { settling: true } : {}),
    gesture: { intent: sentenceGesture(o.text, settled.emotion, o.request), intensity: expressivenessFactor(o.profile) },
    pauseBefore: o.paragraph,
    delivery: deliveryFor({ emotion: settled.emotion, intensity: settled.intensity, profile: o.profile, language: o.language, tone: o.tone }),
  };
}
