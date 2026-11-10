import { it, expect } from "vitest";
import { clean, speechRequest } from "../src/index.ts";
import { comparisonModel, SCENES } from "../../../../bench/voice-compare.ts";

it("Qwen, Fish et VoxCPM2 transmettent la surprise sans modifier la référence ou le texte source", () => {
  const text = "Ah, tu as déjà terminé !";
  const d = { intent: "neutral", emotion: "surprised", intensity: 1.25, profile: "playful", language: "fr" } as const;
  const qwen = clean({ model: "qwen3-tts-1.7b-customvoice.gguf", family: "qwen3_tts", voice: "builtin" });
  expect(speechRequest(qwen, text, "fr", d)).toMatchObject({ input: text, instructions: expect.stringContaining("très surpris") });
  const fish = clean({ model: "fish-audio-s2-pro-q8.gguf", family: "fish_audio", voice: "clone", refText: "Référence" });
  expect(speechRequest(fish, text, "fr", d).input).toBe(`[very surprised] ${text}`);
  const vox = clean({ model: "voxcpm2-bf16.gguf", family: "voxcpm2", voice: "clone", refText: "Référence" });
  expect(speechRequest(vox, text, "fr", d)).toMatchObject({ input: `(very surprised, natural conversational pace, same speaker voice) ${text}`, voice: "voix", options: { retry_badcase: false } });
  expect(vox.refText).toBe("Référence");
  expect(speechRequest(vox, text, "fr").input).toBe(text);
  expect(speechRequest(vox, "(calm) Bonjour", "fr", d).input).toBe("(calm) Bonjour");
  expect(speechRequest(vox, "", "fr", d).input).toBe("");
  expect(speechRequest({ ...vox, model: "vocalrender.gguf" }, text, "fr", d).input).toBe(text);
  expect(speechRequest(vox, text, "fr", { ...d, intent: "reassure", tone: "sarcastique" }).input).toContain("(soft tone,");
});

it("prépare le comparatif VoxCPM2 avec une référence identique entre les essais", () => {
  expect(comparisonModel({ family: "voxcpm2", model: "voxcpm2-bf16.gguf", reference: "ref.wav" })).toMatchObject({ voice: "clone", seed: 42, refText: "" });
  expect(() => comparisonModel({ family: "voxcpm2", model: "voxcpm2-bf16.gguf" })).toThrow("--reference");
  const [low, high] = SCENES.filter(s => s.emotion === "surprised");
  expect(low!.text).toBe(high!.text);
  expect(low!.intensity).toBeLessThan(high!.intensity);
});
