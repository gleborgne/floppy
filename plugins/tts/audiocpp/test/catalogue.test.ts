import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, pcmWav, wavDataUrl } from "@floppy/core";
import { makePlugin, clean, clones, rateOf, speechRequest, voiceNeeds } from "../src/index.ts";
import { KNOWN_VOICE_MODELS } from "../src/known-voices.ts";

const added = KNOWN_VOICE_MODELS.filter(m => ["voxcpm2", "chatterbox", "voxtral_tts", "fish_audio"].includes(m.family));

it("le catalogue contient les quatre familles, leurs contraintes et les vingt vrais identifiants Voxtral", () => {
  expect(added.map(m => m.family)).toEqual(["voxcpm2", "chatterbox", "voxtral_tts", "fish_audio"]);
  const voxtral = added.find(m => m.family === "voxtral_tts")!;
  expect(voxtral.voices).toHaveLength(20); expect(new Set(voxtral.voices.map(v => v.id)).size).toBe(20);
  expect(voxtral.voices.map(v => v.id)).toEqual(expect.arrayContaining(["fr_female", "fr_male", "cheerful_female"]));
  expect(voxtral.licence!.name).toBe("CC-BY-NC-4.0");
  expect(added.find(m => m.family === "fish_audio")!.licence!.name).toBe("Fish Audio Research License");
  for (const model of added) {
    expect(voiceNeeds(model)).toMatchObject({ device: "gpu" });
    expect(voiceNeeds(model).memory).toBeGreaterThan(model.files[0]!.size!);
    const v = clean({ family: model.family, model: model.model, voice: model.clone ? "clone" : "builtin", speaker: model.voices[0]?.id, refText: "Bonjour.", mode: model.mode });
    expect(v.family).toBe(model.family);
    expect(clones(v)).toBe(!!model.clone);
    const request = speechRequest(v, "Bonjour.", "fr");
    if (model.family === "chatterbox") { expect(v.mode).toBe("offline"); expect(request).toHaveProperty("response_format", "wav"); expect(request).not.toHaveProperty("stream_format"); }
    else expect(request).toHaveProperty("stream_format", "sse");
    if (model.family === "fish_audio") { expect(rateOf(v)).toBe(44100); expect(request.options).toEqual({ text_chunk_mode: "tag_aware" }); }
    if (model.family === "voxtral_tts") expect(request).toHaveProperty("options.voice_id", "fr_female");
  }
});

it.each(added)("$id : téléchargement simulé, configuration de la voix, réajout idempotent et suppression", async (entry) => {
  const data = Buffer.from("GGUF simulé");
  const known = { ...entry, files: entry.files.map(f => ({ ...f, size: data.length, sha256: createHash("sha256").update(data).digest("hex") })) };
  const home = mkdtempSync(join(tmpdir(), "tts-catalogue-"));
  const k = new Kernel({ logger: () => {}, home, plugins: [makePlugin([known], [])], downloads: { fetch: (async () => new Response(data)) as typeof fetch } });
  try {
    await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { models: {} } }] });
    const provider = async (id: string) => (await k.items.snapshot()).find(p => p.id === id)!;
    const action = (action: string) => k.items.run({ op: "action", provider: "local-voice-library", id: entry.id, action }, "ui");
    expect(await action("download")).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && !(await provider("local-voice")).items.length; i++) await new Promise(r => setTimeout(r, 10));
    const items = (await provider("local-voice")).items;
    expect(items).toHaveLength(entry.clone ? 1 : 20);
    expect((await provider("local-voice-library")).description).toMatchObject({ fr: expect.stringContaining("qualité à évaluer") });
    expect(items[0]!.values).toMatchObject({ family: entry.family, mode: entry.mode ?? "streaming" });
    if (entry.clone) {
      const item = items[0]!;
      expect(item).toMatchObject({ kind: "voice", status: "warn", values: { voice: "clone", refWav: "", speaker: "" } });
      expect((await provider("local-voice-library")).items[0]!.actions?.some(a => a.id === "use")).toBe(false);
      const voice = (await provider("local-voice")).kinds.find(k => k.id === "voice")!;
      expect(voice.fields.find(f => f.key === "model")!.options).toContainEqual(expect.objectContaining({ value: item.values!.model }));
      const values = { label: "Ma voix", model: item.values!.model, sample: wavDataUrl(pcmWav(16000, new Int16Array(16000))), refText: "" };
      if (entry.family === "fish_audio") {
        expect(await k.items.run({ op: "update", provider: "local-voice", id: item.id, values }, "ui")).toMatchObject({ ok: false, text: expect.stringContaining("Fish Audio") });
        values.refText = "Bonjour, voici ma voix.";
      }
      expect(await k.items.run({ op: "update", provider: "local-voice", id: item.id, values }, "ui")).toMatchObject({ ok: true });
      expect((await provider("local-voice")).items[0]!.status).not.toBe("warn");
    } else {
      expect(items.map(i => i.values!.speaker)).toContain("fr_female");
      expect(items.map(i => i.values!.speaker)).toContain("fr_male");
    }
    await action("download");
    expect((await provider("local-voice")).items).toHaveLength(entry.clone ? 1 : 20);
    expect(await action("remove")).toMatchObject({ ok: true });
    expect((await provider("local-voice")).items).toHaveLength(0);
  } finally { await k.stopAll(); }
});

it("les notes de langue des voix ne disent que ce que le catalogue dit déjà : codes à 2 lettres, niveaux connus, langue imposée cohérente", () => {
  for (const m of KNOWN_VOICE_MODELS) {
    for (const [lang, level] of Object.entries(m.languages ?? {})) {
      expect(lang).toMatch(/^[a-z]{2}$/);
      expect(["good", "fair", "poor"]).toContain(level);
    }
    // Un modèle à langue imposée (Pocket TTS) est bon dans cette langue.
    if (m.language) expect(m.languages?.[m.language]).toBe("good");
  }
  const by = (id: string) => KNOWN_VOICE_MODELS.find((m) => m.id === id)!;
  expect(by("pocket-tts-french").languages).toMatchObject({ fr: "good", en: "poor" });
  expect(by("pocket-tts-english").languages).toMatchObject({ en: "good", fr: "poor" });
  // Pas de note sans source : Supertonic ne dit aucune langue.
  expect(by("supertonic-3").languages).toBeUndefined();
});
