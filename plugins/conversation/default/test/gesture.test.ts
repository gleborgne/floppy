import { it, expect } from "vitest";
import { sentenceGesture } from "../src/gesture.ts";

it.each([
  ["La lumière se sépare en couleurs.", "happy", "Explique-moi les arcs-en-ciel", "explain"],
  ["Light splits into colours.", "neutral", "Explain rainbows", "explain"],
  ["Ensuite, les couleurs ressortent.", undefined, "", "explain"],
  ["Tu veux un exemple ?", "happy", "Explique le phénomène", "question"],
  ["Perhaps we should check.", undefined, "", "question"],
  ["Je ne suis pas sûr.", undefined, "", "question"],
  ["Elles jouaient à cache-cache.", "mischief", "", "playful"],
  ["They were hiding.", undefined, "Tell me a joke", "playful"],
  ["Ça va aller.", "sorry", "Une blague ?", "none"],
  ["C'est terminé.", "happy", "", "none"],
] as const)("intention de %s", (text, emotion, request, expected) => {
  expect(sentenceGesture(text, emotion, request)).toBe(expected);
});
