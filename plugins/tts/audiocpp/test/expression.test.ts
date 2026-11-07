import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expressionProfile, fishDeliveryText } from "../src/expression.ts";
import { clean, speechRequest } from "../src/index.ts";
import { comparisonModel, comparisonPage, sample, SCENES } from "../../../../bench/voice-compare.ts";

describe("profils expressifs audio.cpp", () => {
  it("distingue variantes, modes de voix et noms de fichiers, pas les noms des dossiers", () => {
    expect(expressionProfile("qwen3_tts", "Qwen3-TTS-12Hz-1.7B-CustomVoice-Q8.gguf", "integree")).toBe("instructions");
    expect(expressionProfile("qwen3_tts", "qwen3-tts-1.7b-customvoice.gguf", "clone")).toBe("none");
    expect(expressionProfile("qwen3_tts", "1.7b-customvoice/qwen3-tts-base.gguf", "integree")).toBe("none");
    expect(expressionProfile("fish_audio", "C:\\models\\fish-audio-s2-pro-q8_0.gguf", "clone")).toBe("fish-s2-tags");
    expect(expressionProfile("fish_audio", "fish-audio-s2-pro/model-renamed.gguf", "clone")).toBe("none");
    expect(expressionProfile("voxtral_tts", "voxtral-4b-tts-2603-q8.gguf", "integree")).toBe("none");
  });
  it("garde le même jeu sur les phrases successives et réduit l'intensité sans rire ajouté", () => {
    const d = { intent: "playful", profile: "playful", language: "fr", emotion: "laugh", intensity: 0.3 } as const;
    expect(fishDeliveryText("Un.", d)).toBe("[slightly amused] Un.");
    expect(fishDeliveryText("Deux.", d)).toBe("[slightly amused] Deux.");
    expect(fishDeliveryText("Pourquoi ?", { ...d, emotion: "curious", intensity: 1 })).toBe("[curious] Pourquoi ?");
    expect(fishDeliveryText("Bonjour.", { ...d, intent: "neutral", profile: "natural", intensity: 1 })).toBe("[relaxed] Bonjour.");
    expect(fishDeliveryText("[emphasis] Oui.", d)).toBe("[emphasis] Oui.");
    expect(fishDeliveryText("", d)).toBe("");
  });
  it("la graine est facultative en conversation, conservée et validée pour les comparaisons", () => {
    const model = clean({ model: "fish-audio-s2-pro-q8.gguf", famille: "fish_audio", seed: 42 });
    expect(speechRequest(model, "Bonjour").seed).toBe(42);
    expect(speechRequest(clean({ seed: -1 }), "Bonjour")).not.toHaveProperty("seed");
    expect(speechRequest(clean({}), "Bonjour")).not.toHaveProperty("seed");
  });
});

describe("comparaison vocale locale", () => {
  it("prépare une référence Fish explicite ou une voix Qwen intégrée avec la même graine", () => {
    const dir = mkdtempSync(join(tmpdir(), "expression-test-"));
    const transcript = join(dir, "reference.txt"); writeFileSync(transcript, "Bonjour.");
    expect(comparisonModel({ family: "fish_audio", model: "fish-audio-s2-pro-q8.gguf", reference: "ref.wav", transcript })).toMatchObject({ voix: "clone", refText: "Bonjour.", seed: 42 });
    expect(comparisonModel({ model: "qwen3-tts-1.7b-customvoice.gguf" })).toMatchObject({ voix: "integree", speaker: "ono_anna", seed: 42 });
    expect(() => comparisonModel({ family: "fish_audio", model: "fish-audio-s2-pro-q8.gguf" })).toThrow("--reference");
    expect(() => comparisonModel({ model: "qwen3-tts-base.gguf" })).toThrow("CustomVoice");
  });
  it("la page associe chaque texte aux deux WAV et échappe le nom du modèle", () => {
    const html = comparisonPage('<model>"');
    expect(html).toContain("&lt;model&gt;&quot;");
    for (const scene of SCENES) for (const variant of ["temoin", "joueur"]) expect(html).toContain(`${scene.intent}-${variant}.wav`);
  });
  it("la mesure traverse le vrai contrat TTS et refuse un son vide", async () => {
    const delivery = { intent: "explain", profile: "playful", language: "fr" } as const;
    const result = await sample({ name: "fake", async *speak(text, opts) {
      expect(text).toBe("Bonjour"); expect(opts.delivery).toEqual(delivery);
      yield { rate: 24000, pcm: new Int16Array([1, 2, 3]) };
    } }, "Bonjour", delivery);
    expect(result.audioSeconds).toBe(3 / 24000);
    await expect(sample({ name: "empty", async *speak() {} }, "Bonjour")).rejects.toThrow("aucun son");
  });
});
