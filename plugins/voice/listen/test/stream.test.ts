// Règles d'écoute (reprises du service Python) avec un faux détecteur piloté à la trame près, et le plugin dans le noyau.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type SttService, type VadEvent, type VadService, type VadStream, type VoiceEvent, type VoiceService } from "@floppy/core";
import listen, { ListenStream } from "../src/index.ts";

const FRAME = 512;

/** Faux détecteur : `script[n]` = événement rendu à la n-ième trame (comptée depuis open ou reset). */
function fakeVad(script: Record<number, VadEvent["type"]>) {
  let n = 0;
  const calls = { resets: 0, closed: false };
  const stream: VadStream = {
    push: (f) => { const out: VadEvent[] = []; for (let i = 0; i < f.length / FRAME; i++) { const t = script[n]; if (t) out.push({ type: t, sample: n * FRAME }); n++; } return out; },
    reset: () => { n = 0; calls.resets++; },
    close: () => { calls.closed = true; },
  };
  return { stream, calls };
}

function setup(script: Record<number, VadEvent["type"]>, transcribe: (a: Float32Array) => Promise<string> = async (a) => `${a.length}`) {
  const vad = fakeVad(script);
  let t = 0;
  const events: VoiceEvent[] = [];
  const s = new ListenStream({ vad: vad.stream, minSilenceMs: 500, transcribe, now: () => t });
  s.on((e) => events.push(e));
  const frames = (n: number) => { for (let i = 0; i < n; i++) s.pushAudio(new Float32Array(FRAME).fill(0.1)); };
  return { s, events, frames, vad, tick: (ms: number) => { t += ms; } };
}

const types = (evs: VoiceEvent[]) => evs.map((e) => e.type);

describe("phrases", () => {
  it("début, fin, pré-roll de 10 trames, transcription avec l'horloge du flux", async () => {
    const { events, frames } = setup({ 12: "start", 40: "end" });
    frames(50);
    await vi.waitFor(() => expect(events.some((e) => e.type === "transcript")).toBe(true));
    expect(types(events)).toEqual(["vad", "vad", "transcript"]);
    const tr = events.find((e) => e.type === "transcript")!;
    // 10 trames gardées (3..12, le début compris) + trames 13..40 (la fin comprise)
    expect(tr).toMatchObject({ text: String((10 + 28) * FRAME), merged: false, utt: 1, start_sample: 3 * FRAME, end_sample: 41 * FRAME, silence_ms: 500 });
  });

  it("une phrase de moins de 0,3 s est ignorée", async () => {
    // Au tout début du flux, le pré-roll est court : 3 trames = 96 ms.
    const { events, frames } = setup({ 0: "start", 2: "end" });
    frames(20);
    await new Promise((r) => setTimeout(r, 10));
    expect(types(events)).toEqual(["vad", "vad"]);
  });

  it("les blocs reçus de n'importe quelle taille sont recoupés en trames de 512", async () => {
    const { s, events } = setup({ 12: "start", 40: "end" });
    for (let i = 0; i < 50 * FRAME; i += 700) s.pushAudio(new Float32Array(Math.min(700, 50 * FRAME - i)).fill(0.1));
    await vi.waitFor(() => expect(events.some((e) => e.type === "transcript")).toBe(true));
  });

  it("les résultats sortent dans l'ordre, même si la 2e transcription finit avant la 1re", async () => {
    const delays = [30, 0];
    const { events, frames, tick } = setup({ 12: "start", 30: "end", 120: "start", 140: "end" }, async (a) => { await new Promise((r) => setTimeout(r, delays.shift())); return `${a.length}`; });
    frames(100); tick(5000); frames(60);
    await vi.waitFor(() => expect(events.filter((e) => e.type === "transcript")).toHaveLength(2));
    expect(events.filter((e) => e.type === "transcript").map((e) => (e as { utt: number }).utt)).toEqual([1, 2]);
  });

  it("une transcription en erreur rend un texte vide", async () => {
    const { events, frames } = setup({ 12: "start", 40: "end" }, async () => { throw new Error("panne"); });
    frames(50);
    await vi.waitFor(() => expect(events.find((e) => e.type === "transcript")).toMatchObject({ text: "" }));
  });
});

describe("interruption et recollage", () => {
  it("interruption après 300 ms de parole pendant que la voix joue, une seule fois", () => {
    const { s, events, frames } = setup({ 5: "start" });
    s.setSpeaking(true);
    frames(15); // trames 6..14 : 9 trames de parole après le début = 288 ms
    expect(types(events)).toEqual(["vad"]);
    frames(1); // 10 trames = 320 ms
    expect(types(events)).toEqual(["vad", "barge_in"]);
    frames(20);
    expect(types(events)).toEqual(["vad", "barge_in"]);
  });

  it("reprise moins de 2 s après la fin, sans réponse parlée : même phrase", async () => {
    const { events, frames, tick } = setup({ 12: "start", 30: "end", 40: "start", 60: "end" });
    frames(35); tick(1000); frames(30);
    await vi.waitFor(() => expect(events.filter((e) => e.type === "transcript")).toHaveLength(2));
    expect(types(events).slice(0, 5)).toEqual(["vad", "vad", "merge", "vad", "vad"]);
    const [first, second] = events.filter((e) => e.type === "transcript") as Extract<VoiceEvent, { type: "transcript" }>[];
    expect(second).toMatchObject({ merged: true, start_sample: first!.start_sample });
  });

  it("pas de recollage après 2 s, après une réponse parlée, ou s'il est coupé", async () => {
    for (const before of ["late", "spoke", "off"] as const) {
      const { s, events, frames, tick } = setup({ 12: "start", 30: "end", 40: "start", 60: "end" });
      if (before === "off") s.setMergeEnabled(false);
      frames(35);
      if (before === "late") tick(2500); else tick(500);
      if (before === "spoke") { s.setSpeaking(true); s.setSpeaking(false); }
      frames(30);
      expect(events.some((e) => e.type === "merge")).toBe(false);
    }
  });
});

describe("bouton et dictée", () => {
  it("bouton : le détecteur est ignoré, tout le son est une phrase, silence 0", async () => {
    const { s, events, frames, vad } = setup({});
    s.setSpeaking(true);
    s.ptt(true);
    frames(20);
    s.ptt(false);
    await vi.waitFor(() => expect(events.some((e) => e.type === "transcript")).toBe(true));
    expect(types(events)).toEqual(["vad", "barge_in", "vad", "transcript"]);
    expect(events.at(-1)).toMatchObject({ text: String(20 * FRAME), silence_ms: 0, start_sample: 0, end_sample: 20 * FRAME });
    expect(vad.calls.resets).toBe(2);
  });

  it("dictée : hypothèses régulières (une à la fois), version finale à la pause, pas de transcript", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, events, frames } = setup({ 2: "start", 80: "end" }, async (a) => { await gate; return `${a.length}`; });
    s.dictate(true);
    frames(90);
    release();
    await vi.waitFor(() => expect(events.some((e) => e.type === "dictation" && e.final)).toBe(true));
    const dict = events.filter((e) => e.type === "dictation") as Extract<VoiceEvent, { type: "dictation" }>[];
    // Une seule hypothèse partielle : la suivante attend que la première soit finie.
    expect(dict.map((d) => [d.seg, d.final])).toEqual([[0, false], [0, true]]);
    expect(events.some((e) => e.type === "transcript" || e.type === "vad")).toBe(false);
  });

  it("dictée arrêtée en pleine parole : version finale du segment", async () => {
    const { s, events, frames } = setup({ 2: "start" });
    s.dictate(true);
    frames(20);
    s.dictate(false);
    await vi.waitFor(() => expect(events.find((e) => e.type === "dictation" && e.final)).toMatchObject({ seg: 0 }));
  });
});

describe("fermeture", () => {
  it("annonce la fermeture une fois, ferme le détecteur, plus rien ensuite", async () => {
    const { s, events, frames, vad } = setup({ 12: "start", 40: "end" });
    frames(45);
    s.close(); s.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(types(events)).toEqual(["vad", "vad", "closed"]);
    expect(vad.calls.closed).toBe(true);
  });
});

describe("plugin dans le noyau", () => {
  it("emprunte le détecteur et la transcription au 1er flux, les rend au dernier", async () => {
    const opened: string[] = [];
    let heard: Float32Array | undefined;
    const runtime = definePlugin({
      manifest: { id: "fake-runtime", version: "0", licence: "MIT", provides: ["vad", "stt"] },
      apply(ctx) {
        ctx.offer("vad", { items: () => [{ id: "silero", label: "Silero" }], start(f) {
          opened.push("vad"); f.effect(() => { opened.push("-vad"); });
          f.provide("vad", { name: "silero", minSilenceMs: 500, open: () => fakeVad({ 12: "start", 40: "end" }).stream } satisfies VadService);
        } });
        ctx.offer("stt", { items: () => [{ id: "parakeet", label: "Parakeet" }], start(f) {
          opened.push("stt"); f.effect(() => { opened.push("-stt"); });
          f.provide("stt", { name: "parakeet", transcribe: async (a, o) => { heard = a; return { text: ` bonjour ${o?.language} ` }; } } satisfies SttService);
        } });
      },
    });
    let voice: VoiceService | undefined;
    const consumer = definePlugin({ manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["voice"] }, apply(c) { voice = c.maybe("voice"); } });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "listen-")), plugins: [listen, runtime, consumer] });
    try {
      await k.applyConfig({ plugins: [{ id: "rt", plugin: "fake-runtime" }, { id: "listen", plugin: "voice-listen" }, { id: "c", plugin: "consumer" }] });
      expect(opened).toEqual([]); // rien ne tourne tant qu'aucun corps n'écoute
      const a = await voice!.open("a");
      const b = await voice!.open("b");
      expect(opened).toEqual(["vad", "stt"]);
      expect(a.speak).toBeUndefined();
      const got: VoiceEvent[] = [];
      a.on((e) => got.push(e));
      for (let i = 0; i < 50; i++) a.pushAudio(new Float32Array(FRAME));
      await vi.waitFor(() => expect(got.find((e) => e.type === "transcript")).toMatchObject({ text: "bonjour fr" }));
      expect(heard?.length).toBe(38 * FRAME);
      a.close();
      await k.idle();
      expect(opened).toEqual(["vad", "stt"]);
      b.close();
      await vi.waitFor(async () => { await k.idle(); expect([...opened].sort()).toEqual(["-stt", "-vad", "stt", "vad"]); });
    } finally { await k.stopAll(); }
  });
});
