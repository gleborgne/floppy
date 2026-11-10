// La fiche de chaque émotion : tout ce que le noyau sait d'elle, au même endroit. Typée `Record<Emotion, …>` :
// ajouter une émotion au protocole sans la décrire ici ne compile pas.
// Lue par l'humeur (mood.ts), le jeu vocal (speech-delivery.ts), l'intention de voix et le geste (conversation).
import type { Emotion } from "@floppy/protocol";
import type { SpeechDelivery } from "./voice.ts";

/** Rôle d'une émotion pour le geste d'une phrase : coupe le geste, ou impose un geste (voir sentenceGesture). */
export type GestureRole = "none" | "playful" | "question" | "explain";

export interface EmotionInfo {
  /** Effet sur l'humeur : [valence visée, énergie visée]. */
  affect: [number, number];
  /** Fait bouger l'humeur ? Non pour les émotions de situation (la conversation les met elle-même). */
  moves: boolean;
  /** Couleur de la voix [français, anglais] pour les adaptateurs à consignes. Jamais un événement sonore (« laugh » ne rit pas). */
  voice?: [string, string];
  /** Intention de jeu vocal quand la phrase porte cette émotion. */
  intent: SpeechDelivery["intent"];
  /** Rôle pour le geste de la phrase (absent : le texte décide). */
  gesture?: GestureRole;
}

const GENTLE: [string, string] = ["doux et empathique", "gentle and empathetic"];

export const EMOTION_SHEET: Record<Emotion, EmotionInfo> = {
  neutral: { affect: [0, 0.5], moves: false, intent: "neutral" },
  happy: { affect: [0.6, 0.6], moves: true, voice: ["satisfait et souriant", "pleased and smiling"], intent: "neutral" },
  joy: { affect: [0.85, 0.8], moves: true, voice: ["joyeux et lumineux", "joyful and bright"], intent: "playful" },
  laugh: { affect: [0.9, 0.9], moves: true, voice: ["amusé", "amused"], intent: "playful", gesture: "playful" },
  love: { affect: [0.9, 0.6], moves: true, voice: ["tendre et chaleureux", "affectionate and warm"], intent: "neutral" },
  excited: { affect: [0.75, 1], moves: true, voice: ["enthousiaste", "excited"], intent: "playful" },
  proud: { affect: [0.7, 0.75], moves: true, voice: ["fier et satisfait", "proud and satisfied"], intent: "neutral" },
  sad: { affect: [-0.7, 0.25], moves: true, voice: GENTLE, intent: "reassure", gesture: "none" },
  cry: { affect: [-0.85, 0.35], moves: true, voice: GENTLE, intent: "reassure", gesture: "none" },
  angry: { affect: [-0.7, 0.85], moves: true, voice: ["ferme mais posé", "firm but composed"], intent: "neutral", gesture: "none" },
  annoyed: { affect: [-0.45, 0.6], moves: true, voice: ["ferme mais patient", "firm but patient"], intent: "neutral", gesture: "none" },
  scared: { affect: [-0.55, 0.9], moves: true, voice: ["calme et rassurant", "calm and reassuring"], intent: "reassure", gesture: "none" },
  surprised: { affect: [0.1, 0.85], moves: true, voice: ["surpris", "surprised"], intent: "neutral" },
  shocked: { affect: [-0.2, 0.95], moves: true, voice: ["étonné", "astonished"], intent: "neutral" },
  confused: { affect: [-0.25, 0.5], moves: true, voice: ["perplexe et hésitant", "puzzled and hesitant"], intent: "neutral", gesture: "question" },
  skeptical: { affect: [-0.2, 0.5], moves: true, voice: ["dubitatif", "skeptical"], intent: "neutral", gesture: "question" },
  mischief: { affect: [0.5, 0.75], moves: true, voice: ["malicieux et complice", "mischievous and friendly"], intent: "playful", gesture: "playful" },
  wink: { affect: [0.5, 0.65], moves: true, voice: ["complice", "playful"], intent: "playful", gesture: "playful" },
  shy: { affect: [0.3, 0.4], moves: true, voice: ["timide", "shy"], intent: "neutral" },
  bored: { affect: [-0.15, 0.15], moves: true, voice: ["sobre", "understated"], intent: "neutral" },
  tired: { affect: [-0.1, 0.12], moves: true, voice: ["posé", "calm"], intent: "neutral" },
  sleepy: { affect: [0, 0.05], moves: false, voice: ["doux et détendu", "soft and relaxed"], intent: "neutral" },
  thinking: { affect: [0, 0.55], moves: false, voice: ["réfléchi", "thoughtful"], intent: "explain", gesture: "question" },
  curious: { affect: [0.25, 0.7], moves: true, voice: ["curieux", "curious"], intent: "explain", gesture: "question" },
  focused: { affect: [0.05, 0.65], moves: false, voice: ["concentré et précis", "focused and clear"], intent: "explain", gesture: "explain" },
  sorry: { affect: [-0.45, 0.35], moves: true, voice: GENTLE, intent: "reassure", gesture: "none" },
  relieved: { affect: [0.45, 0.4], moves: true, voice: ["soulagé", "relieved"], intent: "neutral" },
  determined: { affect: [0.3, 0.85], moves: true, voice: ["déterminé", "determined"], intent: "neutral" },
};

/** La fiche d'une émotion, ou rien si le nom n'en est pas une (le cerveau ou un plugin peut donner un mot inconnu). */
export function emotionInfo(emotion: string | undefined): EmotionInfo | undefined {
  return emotion && Object.hasOwn(EMOTION_SHEET, emotion) ? EMOTION_SHEET[emotion as Emotion] : undefined;
}

/** Part de l'émotion montrée selon l'expressivité choisie : discrète 0.45, naturelle 0.8, joueuse 1. */
export function expressivenessFactor(profile: SpeechDelivery["profile"]): number {
  return profile === "discreet" ? 0.45 : profile === "natural" ? 0.8 : 1;
}
