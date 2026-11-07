import { it, expect } from "vitest";
import { sample } from "../../../bench/voice-compare.ts";
it("assemble les blocs PCM en WAV et mesure la durée audio", async () => {
  const r = await sample({ name: "test", async *speak() { yield { rate: 16000, pcm: new Int16Array(1600) }; yield { rate: 16000, pcm: new Int16Array(1600) }; } }, "Bonjour");
  expect(r.audioSeconds).toBe(0.2); expect(r.wav.length).toBe(6444); expect(r.firstAudioMs).toBeGreaterThanOrEqual(0);
  expect(Buffer.from(r.wav).toString("ascii", 0, 4)).toBe("RIFF");
});
it("refuse un flux vide ou des débits incohérents", async () => {
  await expect(sample({ name: "vide", async *speak() {} }, "x")).rejects.toThrow("aucun son");
  await expect(sample({ name: "test", async *speak() { yield { rate: 16000, pcm: new Int16Array(1) }; yield { rate: 24000, pcm: new Int16Array(1) }; } }, "x")).rejects.toThrow("changé");
});
