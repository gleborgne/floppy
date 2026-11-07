import type { SpeechGesture } from "@floppy/protocol";
import { norm } from "./text.ts";

/** Première mise en scène par phrase : émotions du cerveau et indices bilingues, sans nouvel appel modèle. */
export function sentenceGesture(text: string, emotion?: string, request = ""): SpeechGesture {
  if (["sad", "sorry", "cry", "scared", "angry", "annoyed"].includes(emotion ?? "")) return "none";
  const phrase = norm(text), asked = norm(request);
  if (["mischief", "wink", "laugh"].includes(emotion ?? "")) return "playful";
  if (/\?|\b(peut-etre|je ne suis pas sur|maybe|perhaps|not sure)\b/.test(phrase)
    || ["curious", "confused", "skeptical", "thinking"].includes(emotion ?? "")) return "question";
  if (/\b(blague|plaisanterie|joke)\b/.test(asked)) return "playful";
  if (emotion === "focused" || /\b(parce que|donc|d'abord|ensuite|par exemple|because|therefore|first|then|for example)\b/.test(phrase)
    || /\b(explique|expliquer|explain|comment .*fonctionne|how .*works?)\b/.test(asked)) return "explain";
  return "none";
}
