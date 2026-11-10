// Studio de voix : une voix = un enregistrement + le modèle qui la fait parler (faux serveur audio.cpp, faux processus).
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, pcmWav, wavDataUrl, wavPcm } from "@floppy/core";
import type { TtsService } from "@floppy/contracts";
import tts, { clones, PROMPTS } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "tts-studio-files-"));
const file = (name: string, bytes = 2048) => { const p = join(dir, name); writeFileSync(p, Buffer.alloc(bytes)); return p; };
const model = file("qwen3-tts-base.gguf");
const pocket = file("pocket-tts-french-q8_0.gguf");
const wav = file("ref.wav");
const b64 = (...samples: number[]) => Buffer.from(new Int16Array(samples).buffer).toString("base64");
const sse = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;

/** Un vrai petit WAV (à 16 kHz) en adresse data:, comme l'envoie la fenêtre. */
const recording = (seconds = 1) => wavDataUrl(pcmWav(16000, new Int16Array(16000 * seconds).fill(100)));

type Reply = { ok: boolean; text: string; id?: string; audio?: string };

async function kernel(extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "tts-studio-"));
  const k = new Kernel({ logger: () => {}, home, plugins: [tts] });
  const models = {
    q: { label: "Qwen", model, voice: "builtin", speaker: "Vivian" },
    s: { label: "Super", model: file("supertonic.gguf"), family: "supertonic", voice: "builtin", speaker: "F1" },
  };
  await k.applyConfig({ plugins: [{ id: "tts", plugin: "tts-audiocpp", config: { exe: file("fake-studio.exe"), scanDirs: [], models, ...extra } }] });
  const run = (op: Record<string, unknown>) => k.items.run({ provider: "local-voice", ...op } as never, "ui") as Promise<Reply>;
  const prov = async () => (await k.items.snapshot()).find((x) => x.id === "local-voice")!;
  return { k, home, run, prov };
}

describe("studio de voix", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("le formulaire d'une voix ne propose que les modèles qui savent cloner", async () => {
    const { k, prov } = await kernel();
    try {
      const voice = (await prov()).kinds.find((x) => x.id === "voice")!;
      const field = (key: string) => voice.fields.find((f) => f.key === key)!;
      expect(field("sample")).toMatchObject({ type: "audio", textKey: "refText", seconds: { min: 10, max: 20 } });
      expect(field("sample").prompts!.length).toBeGreaterThan(2);
      expect(field("model").options!.map((o) => o.value)).toEqual([model]); // Supertonic et Qwen3 CustomVoice ne clonent pas
      expect(field("trial").default).toBe("Bonjour ! Je suis Floppy. Tu veux que je lise tes mails du jour ?");
    } finally { await k.stopAll(); }
  });

  it("les phrases à lire font au moins 40 mots (plus de 10 s à voix normale), en français et en anglais", () => {
    for (const p of PROMPTS as { fr: string; en: string }[]) for (const s of [p.fr, p.en]) expect(s.split(/\s+/).length).toBeGreaterThanOrEqual(40);
  });

  it("Qwen3 CustomVoice ne clone pas : la voix est refusée, et une voix existante montre pourquoi", async () => {
    const custom = file("qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf");
    const { k, run, prov } = await kernel({ models: {
      c: { label: "Custom", model: custom, voice: "builtin", speaker: "Vivian" },
      v: { label: "Clémentine", model: custom, voice: "clone", refWav: wav, refText: "x" },
    } });
    try {
      const r = await run({ op: "add", kind: "voice", values: { label: "Ma voix", sample: recording(), model: custom } });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/ne sait pas cloner/);
      const v = (await prov()).items.find((i) => i.id === "v")!;
      expect(v.status).toBe("error");
      expect((v.statusText as { fr: string }).fr).toMatch(/ne sait pas cloner/);
    } finally { await k.stopAll(); }
  });

  it("clones : la famille et la variante lue dans le nom du fichier", () => {
    const m = (model: string, family = "qwen3_tts") => ({ family, familyOther: "", model });
    expect(clones(m("C:/models/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf"))).toBe(true);
    expect(clones(m("C:/models/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf"))).toBe(false);
    expect(clones(m("C:\\models\\Qwen3-TTS-12Hz-1.7B-VoiceDesign.gguf"))).toBe(false);
    expect(clones(m("C:/models/pocket-tts-french-q8_0.gguf", "pocket_tts"))).toBe(true);
    expect(clones(m("C:/models/supertonic-3-f16.gguf", "supertonic"))).toBe(false);
  });

  it("garder une voix : copiée chez Floppy ; Écouter la rend ; un nouvel enregistrement remplace l'ancien ; supprimer l'efface", async () => {
    const { k, home, run, prov } = await kernel();
    try {
      expect((await run({ op: "add", kind: "voice", values: { label: "Ma voix", model } })).ok).toBe(false); // pas d'enregistrement
      const r = await run({ op: "add", kind: "voice", values: { label: "Ma voix", sample: recording(), refText: "Le matin…", model } });
      expect(r).toMatchObject({ ok: true, id: "ma-voix" });
      const it1 = (await prov()).items.find((i) => i.id === "ma-voix")!;
      const saved = String(it1.values!.refWav);
      expect(saved.startsWith(join(home, "tts-audiocpp", "voices"))).toBe(true);
      expect(existsSync(saved)).toBe(true);
      expect(it1).toMatchObject({ kind: "voice", values: { sample: saved, refText: "Le matin…", family: "qwen3_tts", voice: "clone" }, actions: [{ id: "listen", play: true }] });
      expect((it1.detail as { fr: string }).fr).toBe("voix clonée · 1 s d'enregistrement · parle avec qwen3-tts-base.gguf");
      const l = await run({ op: "action", id: "ma-voix", action: "listen" });
      expect(l.audio?.startsWith("data:audio/wav;base64,")).toBe(true);
      // Modifier sans nouvel enregistrement : le fichier reste.
      expect((await run({ op: "update", id: "ma-voix", values: { label: "Ma voix", sample: saved, refText: "Autre", model } })).ok).toBe(true);
      expect((await prov()).items.find((i) => i.id === "ma-voix")!.values).toMatchObject({ refWav: saved, refText: "Autre" });
      // Nouvel enregistrement : nouveau fichier, l'ancien est effacé.
      await run({ op: "update", id: "ma-voix", values: { label: "Ma voix", sample: recording(2), refText: "Autre", model } });
      const next = String((await prov()).items.find((i) => i.id === "ma-voix")!.values!.refWav);
      expect(next).not.toBe(saved);
      expect(existsSync(saved)).toBe(false);
      await run({ op: "remove", id: "ma-voix" });
      expect(existsSync(next)).toBe(false);
    } finally { await k.stopAll(); }
  });

  it("un fichier de l'utilisateur n'est jamais effacé", async () => {
    const { k, run } = await kernel({ models: { u: { label: "Lui", model, voice: "clone", refWav: wav, refText: "x" } } });
    try {
      expect((await run({ op: "update", id: "u", values: { label: "Lui", sample: recording(), model } })).ok).toBe(true);
      expect(existsSync(wav)).toBe(true);
    } finally { await k.stopAll(); }
  });

  it("essayer sans modèle chargé : explique comment l'entendre, sans erreur", async () => {
    const { k, run } = await kernel();
    try {
      const t = await run({ op: "test", kind: "voice", values: { label: "x", sample: recording(), model } });
      expect(t.ok).toBe(true);
      expect(t.text).toMatch(/Aucune voix audio\.cpp n'est chargée/);
      expect(t.audio).toBeUndefined();
    } finally { await k.stopAll(); }
  });

  it.each([
    { loadedModel: model, family: "qwen3_tts", name: "qwen3-tts-base.gguf", otherModel: pocket, otherName: "pocket-tts-french-q8_0.gguf" },
    { loadedModel: pocket, family: "pocket_tts", name: "pocket-tts-french-q8_0.gguf", otherModel: model, otherName: "qwen3-tts-base.gguf" },
  ])("essayer avec $family chargé : utilise ce modèle seulement, rend le son en WAV", async ({ loadedModel, family, name, otherModel, otherName }) => {
    const state = { running: false, bodies: [] as Record<string, unknown>[] };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/health")) { if (!state.running) throw new Error("stopped"); return new Response("{}"); }
      state.bodies.push(JSON.parse(init!.body!));
      return new Response(sse({ type: "speech.audio.delta", audio: b64(5, 6, 7) }));
    }));
    const wrapped: typeof tts = {
      ...tts,
      apply: (ctx, c) => tts.apply({
        ...ctx,
        offer: ((svc: never, def: { start: (f: typeof ctx, id: string) => unknown }) => ctx.offer(svc, {
          ...def,
          start: (f: typeof ctx, id: string) => def.start({
            ...f,
            spawn: (() => { state.running = true; return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => { state.running = false; } }); }) as unknown as typeof ctx.spawn,
          } as typeof ctx, id),
        } as never)) as unknown as typeof ctx.offer,
      } as typeof ctx, c),
    };
    const consumer = definePlugin({
      manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: "voice.tts", service: "tts", section: "voice", label: "Voix" }] },
      async apply(c) { await c.slot<TtsService>("voice.tts"); },
    });
    const home = mkdtempSync(join(tmpdir(), "tts-trial-"));
    const k = new Kernel({ logger: () => {}, home, plugins: [wrapped, consumer] });
    const base = { id: "tts", plugin: "tts-audiocpp", config: { exe: file("fake-trial.exe"), port: 8096, backend: "cpu", scanDirs: [], models: { q: { label: name, model: loadedModel, family, voice: "clone", refWav: wav, refText: "Bonjour" } } } };
    try {
      await k.applyConfig({ plugins: [base, { id: "c", plugin: "consumer" }], slots: { "voice.tts": "tts/q" } });
      const t = await k.items.run({ provider: "local-voice", op: "test", kind: "voice", values: { label: "x", sample: recording(), refText: "Le matin\nau soleil", model: loadedModel, trial: "Salut" } } as never, "ui") as Reply;
      expect(t.ok).toBe(true);
      expect(t.text).toContain(`Essai avec ${name}`);
      const body = state.bodies.at(-1)!;
      expect(body).toMatchObject({ model: "modele", input: "Salut", stream_format: "sse" });
      if (family === "qwen3_tts") expect(body.reference_text).toBe("Le matin au soleil");
      else {
        expect(body).not.toHaveProperty("reference_text");
        expect(body).not.toHaveProperty("options");
      }
      expect(String(body.voice_ref)).toBe(join(home, "tts-audiocpp", "essai.wav").replace(/\\/g, "/"));
      expect(body).not.toHaveProperty("voice");
      const back = wavPcm(new Uint8Array(Buffer.from(t.audio!.split(",")[1]!, "base64")));
      expect([...back.pcm]).toEqual([5, 6, 7]);
      expect(back.rate).toBe(24000);
      // Changer de modèle dans le formulaire ne doit jamais utiliser celui encore chargé.
      const before = state.bodies.length;
      const other = await k.items.run({ provider: "local-voice", op: "test", kind: "voice", values: {
        label: "x", sample: recording(), model: otherModel, trial: "Salut",
      } } as never, "ui") as Reply;
      expect(state.bodies).toHaveLength(before);
      expect(other.ok).toBe(true);
      expect(other.audio).toBeUndefined();
      expect(other.text).toContain(otherName);
      expect(other.text).toContain(name);
      expect(other.text).toMatch(/Garde la voix puis choisis-la/);
      // La voix en service garde « Supprimer » ; le clic explique quoi faire au lieu de rien montrer.
      const q = (await k.items.snapshot()).find((x) => x.id === "local-voice")!.items.find((i) => i.id === "q")!;
      expect(q.removable).toBe(true);
      const del = await k.items.run({ provider: "local-voice", op: "remove", id: "q" } as never, "ui") as Reply;
      expect(del.ok).toBe(false);
      expect(del.text).toMatch(/chargé en ce moment : choisis d'abord une autre voix/);
    } finally { await k.stopAll(); }
  });
});
