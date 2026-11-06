// Lecteur sherpa-onnx : reconnaissance des modèles, détecteur -> contrat vad, cycle de vie dans le noyau (faux natif).
// Avec FLOPPY_TEST_SHERPA=<dossier> (silero_vad.onnx + un dossier Parakeet TDT avec test_wavs/fr.wav) : essai réel,
// de bout en bout avec le plugin Écoute.
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, wavPcm, type SttService, type VadService, type VoiceEvent, type VoiceService } from "@floppy/core";
import listen from "@floppy/plugin-voice-listen";
import sherpa, { detect, makePlugin, vadStream } from "../src/index.ts";
import type { Native, SherpaVad } from "../src/native.ts";

const dir = mkdtempSync(join(tmpdir(), "sherpa-"));
const touch = (p: string) => { writeFileSync(p, "x"); return p; };
const vadFile = touch(join(dir, "silero_vad.onnx"));
const sttDir = join(dir, "parakeet");
mkdirSync(sttDir);
for (const f of ["encoder.onnx", "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) touch(join(sttDir, f));

describe("reconnaître un modèle à ses fichiers", () => {
  it("fichier .onnx : détecteur ; dossier complet : transcription (int8 d'abord)", () => {
    expect(detect(vadFile)).toEqual({ kind: "vad", file: vadFile });
    expect(detect(sttDir)).toEqual({ kind: "stt", encoder: join(sttDir, "encoder.int8.onnx"), decoder: join(sttDir, "decoder.int8.onnx"), joiner: join(sttDir, "joiner.int8.onnx"), tokens: join(sttDir, "tokens.txt") });
  });
  it("introuvable, mauvaise extension, dossier incomplet : erreur claire", () => {
    expect(detect(join(dir, "absent"))).toMatchObject({ kind: "error" });
    expect(detect(touch(join(dir, "x.bin")))).toMatchObject({ kind: "error", reason: { fr: expect.stringMatching(/\.onnx/) } });
    const half = join(dir, "half"); mkdirSync(half); touch(join(half, "encoder.onnx"));
    expect(detect(half)).toMatchObject({ kind: "error", reason: { fr: expect.stringMatching(/tokens\.txt/) } });
  });
});

function fakeVad(script: boolean[]): SherpaVad & { resets: number } {
  let i = 0;
  return { resets: 0, acceptWaveform() { i++; }, isDetected: () => script[i - 1] ?? false, isEmpty: () => true, pop() {}, reset() { this.resets++; i = 0; } };
}

describe("détecteur sherpa -> contrat vad", () => {
  it("débuts et fins aux changements d'état, index en échantillons, reset remet à zéro", () => {
    const v = fakeVad([false, true, true, false]);
    const s = vadStream(v);
    const out = [0, 1, 2, 3].map(() => s.push(new Float32Array(512)));
    expect(out).toEqual([[], [{ type: "start", sample: 1024 }], [], [{ type: "end", sample: 2048 }]]);
    s.reset();
    expect(s.push(new Float32Array(512))).toEqual([]);
    expect(v.resets).toBe(1);
  });
});

describe("cycle de vie dans le noyau (faux natif)", () => {
  it("chaque modèle est offert au bon service, chargé seulement quand il sert", async () => {
    const loaded: string[] = [];
    const native: Native = {
      vad: () => { loaded.push("vad"); return fakeVad([]); },
      recognizer: async (config) => { loaded.push("stt"); expect(config).toMatchObject({ modelConfig: { numThreads: 3 } }); return { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: " salut " }) }; },
    };
    let vad: VadService | undefined, stt: SttService | undefined;
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", slots: [
        { id: "listen.vad", service: "vad", section: "ecoute", label: "VAD" },
        { id: "listen.stt", service: "stt", section: "ecoute", label: "STT" }] },
      async apply(c) { vad = await c.slot<VadService>("listen.vad"); stt = await c.slot<SttService>("listen.stt"); },
    });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "sherpa-home-")), plugins: [makePlugin(native), consumer] });
    const models = { silero: { label: "Silero", path: vadFile, minSilenceMs: 400 }, parakeet: { label: "Parakeet", path: sttDir, threads: 3 } };
    try {
      await k.applyConfig({ plugins: [{ id: "sherpa", plugin: "stt-sherpa", config: { models } }] });
      expect(loaded).toEqual([]);
      const p = (await k.items.snapshot()).find((x) => x.id === "sherpa")!;
      expect(p.items.map((i) => [i.id, (i.detail as { fr: string }).fr])).toEqual([["silero", "détecteur de parole"], ["parakeet", "transcription"]]);
      await k.applyConfig({ plugins: [{ id: "sherpa", plugin: "stt-sherpa", config: { models } }, { id: "c", plugin: "consumer" }] });
      expect(loaded).toEqual(["vad", "stt"]);
      expect(vad?.minSilenceMs).toBe(400);
      expect(await stt!.transcribe(new Float32Array(16000))).toEqual({ text: "salut" });
      const r = await k.items.run({ provider: "sherpa", op: "remove", id: "parakeet" } as never, "ui");
      expect(r.ok).toBe(false); // il sert : on ne le retire pas
    } finally { await k.stopAll(); }
  });
});

const real = process.env.FLOPPY_TEST_SHERPA;
describe.runIf(!!real && existsSync(real))("pour de vrai (FLOPPY_TEST_SHERPA)", () => {
  it("Écoute + sherpa-onnx : une phrase française du micro devient un transcript", async () => {
    const root = real!;
    const parakeet = readdirSync(root).map((n) => join(root, n)).find((p) => detect(p).kind === "stt")!;
    const wav = wavPcm(readFileSync(join(parakeet, "test_wavs", "fr.wav")));
    let voice: VoiceService | undefined;
    const consumer = definePlugin({ manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["voice"] }, apply(c) { voice = c.maybe("voice"); } });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "sherpa-real-")), plugins: [sherpa, listen, consumer] });
    const models = { silero: { label: "Silero", path: join(root, "silero_vad.onnx") }, parakeet: { label: "Parakeet", path: parakeet } };
    try {
      await k.applyConfig({ plugins: [{ id: "sherpa", plugin: "stt-sherpa", config: { models } }, { id: "listen", plugin: "voice-listen" }, { id: "c", plugin: "consumer" }] });
      const s = await voice!.open("corps");
      const got: VoiceEvent[] = [];
      s.on((e) => got.push(e));
      // Le son du « micro » : la phrase, puis 1 s de silence, par blocs de 20 ms comme un corps.
      // (rééchantillonné en 16 kHz par interpolation linéaire : l'exemple est à 22,05 kHz)
      const n = Math.floor((wav.pcm.length * 16000) / wav.rate);
      const pcm = new Float32Array(n + 16000);
      for (let i = 0; i < n; i++) {
        const x = (i * wav.rate) / 16000, j = Math.floor(x), a = wav.pcm[j] ?? 0, b = wav.pcm[j + 1] ?? a;
        pcm[i] = (a + (b - a) * (x - j)) / 32768;
      }
      for (let i = 0; i < pcm.length; i += 320) s.pushAudio(pcm.subarray(i, i + 320));
      await vi.waitFor(() => expect(got.some((e) => e.type === "transcript")).toBe(true), { timeout: 20_000 });
      const t = got.find((e) => e.type === "transcript") as Extract<VoiceEvent, { type: "transcript" }>;
      expect(t.text.length).toBeGreaterThan(10);
      expect(got.filter((e) => e.type === "vad").map((e) => (e as { state: string }).state)).toContain("speech");
      console.log(`transcript (${t.audio_s} s, ${t.stt_ms} ms) : ${t.text}`);
      s.close();
    } finally { await k.stopAll(); }
  }, 60_000);
});

describe("bibliothèque : télécharger un modèle connu (réseau simulé)", () => {
  it("le modèle téléchargé rejoint la liste, prêt à activer ; Supprimer le retire", async () => {
    const { createHash } = await import("node:crypto");
    const body = (name: string) => Buffer.from(`contenu de ${name}`);
    const sha = (name: string) => createHash("sha256").update(body(name)).digest("hex");
    const url = (name: string) => `https://huggingface.co/x/resolve/abc/${name}`;
    const files = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
    const known = [{
      id: "mini-stt", label: { fr: "Mini STT", en: "Mini STT" }, target: "mini",
      files: files.map((f) => ({ url: url(f), path: `mini/${f}`, size: body(f).length, sha256: sha(f) })),
    }];
    const asked: string[] = [];
    const fetch = (async (u: string) => {
      asked.push(u);
      const name = u.slice(u.lastIndexOf("/") + 1);
      return new Response(body(name), { status: 200, headers: { "content-length": String(body(name).length) } });
    }) as unknown as typeof globalThis.fetch;
    const native: Native = { vad: () => fakeVad([]), recognizer: async () => ({ createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: "" }) }) };
    const k = new Kernel({ logger: () => {}, plugins: [makePlugin(native, known)], downloads: { fetch } });
    await k.applyConfig({ plugins: [{ id: "sherpa", plugin: "stt-sherpa" }], services: {} });
    const snap = async () => Object.fromEntries((await k.items.snapshot()).map((p) => [p.id, p]));
    expect((await snap())["sherpa-library"]).toMatchObject({ layout: "library", offers: ["vad", "stt"] });
    expect((await snap())["sherpa"]!.items).toHaveLength(0);

    await k.items.run({ op: "action", provider: "sherpa-library", id: "mini-stt", action: "download" }, "ui");
    for (let i = 0; i < 100 && !(await snap())["sherpa"]!.items.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual(files.map(url));
    const item = (await snap())["sherpa"]!.items[0]!;
    expect(item).toMatchObject({ label: "Mini STT", values: { path: join(k.modelsDir, "sherpa", "mini") } });
    expect(k.settings.list().find((s) => s.key === "slot.listen.stt")).toBeUndefined(); // aucun consommateur ici
    expect((await snap())["sherpa-library"]!.items[0]).toMatchObject({ status: "ok", actions: [{ id: "remove" }] });

    await k.items.run({ op: "action", provider: "sherpa-library", id: "mini-stt", action: "remove" }, "ui");
    expect((await snap())["sherpa"]!.items).toHaveLength(0);
    expect(existsSync(join(k.modelsDir, "sherpa", "mini"))).toBe(false);
  });

  it("les modèles connus ont des adresses figées et une empreinte pour chaque fichier", async () => {
    const { KNOWN_MODELS } = await import("../src/known-models.ts");
    for (const m of KNOWN_MODELS) {
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(0);
        expect(f.url).not.toMatch(/\/resolve\/main\//);
        expect(f.path.startsWith(m.target)).toBe(true);
      }
    }
  });
});
