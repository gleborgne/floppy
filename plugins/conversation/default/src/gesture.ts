import type { SpeechGesture } from "@floppy/protocol";
import { emotionInfo } from "@floppy/toolkit";
import { norm } from "./text.ts";

/** Première mise en scène par phrase : émotions du cerveau et indices bilingues, sans nouvel appel modèle. */
export function sentenceGesture(text: string, emotion?: string, request = ""): SpeechGesture {
  // La fiche des émotions dit lesquelles coupent le geste, le jouent, le questionnent ou l'expliquent.
  const role = emotionInfo(emotion)?.gesture;
  if (role === "none") return "none";
  const phrase = norm(text), asked = norm(request);
  if (role === "playful") return "playful";
  if (/\?|\b(peut-etre|je ne suis pas sur|maybe|perhaps|not sure)\b/.test(phrase)
    || role === "question") return "question";
  if (/\b(blague|plaisanterie|joke)\b/.test(asked)) return "playful";
  if (role === "explain" || /\b(parce que|donc|d'abord|ensuite|par exemple|because|therefore|first|then|for example)\b/.test(phrase)
    || /\b(explique|expliquer|explain|comment .*fonctionne|how .*works?)\b/.test(asked)) return "explain";
  return "none";
}
