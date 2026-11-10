// Règles d'écoute (reprises du service Python) avec un faux détecteur piloté à la trame près, et le plugin dans le noyau.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "@floppy/core";
import type { SttService, VadEvent, VadService, VadStream, VoiceEvent, VoiceService } from "@floppy/contracts";
import listen, { ListenStream, looksUnfinished } from "../src/index.ts";

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

  it("la transcription tombe en panne pendant qu'un flux est ouvert : elle est réempruntée", async () => {
    let gen = 0;
    let stt!: { fail(r: string): void };
    const runtime = definePlugin({
      manifest: { id: "fake-runtime", version: "0", licence: "MIT", provides: ["vad", "stt"] },
      apply(ctx) {
        ctx.offer("vad", { items: () => [{ id: "silero", label: "Silero" }], start(f) {
          f.provide("vad", { name: "silero", minSilenceMs: 500, open: () => fakeVad({ 12: "start", 40: "end", 112: "start", 140: "end" }).stream } satisfies VadService);
        } });
        ctx.offer("stt", { items: () => [{ id: "parakeet", label: "Parakeet" }], start(f) {
          const mine = ++gen;
          stt = f;
          f.provide("stt", { name: "parakeet", transcribe: async () => ({ text: `moteur ${mine}` }) } satisfies SttService);
        } });
      },
    });
    let voice: VoiceService | undefined;
    const consumer = definePlugin({ manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["voice"] }, apply(c) { voice = c.maybe("voice"); } });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "listen-")), plugins: [listen, runtime, consumer], retryDelays: [] });
    try {
      await k.applyConfig({ plugins: [{ id: "rt", plugin: "fake-runtime" }, { id: "listen", plugin: "voice-listen" }, { id: "c", plugin: "consumer" }] });
      const a = await voice!.open("a");
      const got: VoiceEvent[] = [];
      a.on((e) => got.push(e));
      stt.fail("panne");
      await vi.waitFor(() => expect(gen).toBe(2));
      for (let i = 0; i < 50; i++) a.pushAudio(new Float32Array(FRAME));
      await vi.waitFor(() => expect(got.find((e) => e.type === "transcript")).toMatchObject({ text: "moteur 2" }));
      a.close();
    } finally { await k.stopAll(); }
  });

  it("le détecteur de parole tombe en panne pendant qu'un flux est ouvert : le flux suit le nouveau", async () => {
    let vadGen = 0;
    let vadFork!: { fail(r: string): void };
    const runtime = definePlugin({
      manifest: { id: "fake-runtime", version: "0", licence: "MIT", provides: ["vad", "stt"] },
      apply(ctx) {
        ctx.offer("vad", { items: () => [{ id: "silero", label: "Silero" }], start(f) {
          const mine = ++vadGen;
          vadFork = f;
          // Le premier détecteur n'entend rien ; celui d'après une panne entend une phrase.
          f.provide("vad", { name: "silero", minSilenceMs: 500, open: () => fakeVad(mine === 1 ? {} : { 12: "start", 40: "end" }).stream } satisfies VadService);
        } });
        ctx.offer("stt", { items: () => [{ id: "parakeet", label: "Parakeet" }], start(f) {
          f.provide("stt", { name: "parakeet", transcribe: async () => ({ text: "entendu" }) } satisfies SttService);
        } });
      },
    });
    let voice: VoiceService | undefined;
    const consumer = definePlugin({ manifest: { id: "consumer", version: "0", licence: "MIT", optional: ["voice"] }, apply(c) { voice = c.maybe("voice"); } });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "listen-")), plugins: [listen, runtime, consumer], retryDelays: [] });
    try {
      await k.applyConfig({ plugins: [{ id: "rt", plugin: "fake-runtime" }, { id: "listen", plugin: "voice-listen" }, { id: "c", plugin: "consumer" }] });
      const a = await voice!.open("a");
      const got: VoiceEvent[] = [];
      a.on((e) => got.push(e));
      vadFork.fail("panne");
      await vi.waitFor(() => expect(vadGen).toBe(2));
      await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 52; i++) a.pushAudio(new Float32Array(FRAME));
      await vi.waitFor(() => expect(got.find((e) => e.type === "transcript")).toMatchObject({ text: "entendu" }));
      a.close();
    } finally { await k.stopAll(); }
  });
});

describe("fin de phrase adaptative", () => {
  /** Flux avec minuteur manuel : `fire()` déclenche l'attente en cours. */
  function holdSetup(script: Record<number, VadEvent["type"]>, texts: string[], hold: number | undefined = 1200) {
    const vad = fakeVad(script);
    let t = 0;
    const events: VoiceEvent[] = [];
    let timer: (() => void) | undefined;
    const waits: number[] = [];
    const s = new ListenStream({
      vad: vad.stream, minSilenceMs: 500, now: () => t, holdIncompleteMs: hold,
      transcribe: async () => texts.shift() ?? "",
      schedule: (fn, ms) => { timer = fn; waits.push(ms); return () => { if (timer === fn) timer = undefined; }; },
    });
    s.on((e) => events.push(e));
    const frames = (n: number) => { for (let i = 0; i < n; i++) s.pushAudio(new Float32Array(FRAME).fill(0.1)); };
    const transcripts = () => events.filter((e) => e.type === "transcript") as Extract<VoiceEvent, { type: "transcript" }>[];
    return { s, events, frames, tick: (ms: number) => { t += ms; }, fire: () => timer?.(), armed: () => timer !== undefined, waits, transcripts };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("phrase complète : émise tout de suite", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["Quelle heure est-il ?"]);
    h.frames(50);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
    expect(h.armed()).toBe(false);
  });

  it("phrase inachevée : retenue, puis émise à la fin de l'attente avec silence_ms rallongé", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["envoie ça à euh"]);
    h.frames(50);
    await flush();
    expect(h.transcripts()).toHaveLength(0);
    expect(h.waits).toEqual([1200]);
    h.tick(1200);
    h.fire();
    expect(h.transcripts()).toMatchObject([{ text: "envoie ça à euh", merged: false, utt: 1, silence_ms: 1700 }]);
  });

  it("reprise pendant l'attente : un seul transcript recollé, le texte retenu n'est jamais émis", async () => {
    const h = holdSetup({ 12: "start", 30: "end", 40: "start", 60: "end" }, ["envoie ça à euh", "envoie ça à Paul"]);
    h.frames(35);
    await flush();
    expect(h.armed()).toBe(true);
    h.tick(1000);
    h.frames(30);
    expect(h.armed()).toBe(false);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
    await flush();
    expect(h.transcripts()).toMatchObject([{ text: "envoie ça à Paul", merged: true }]);
    expect(h.events.filter((e) => e.type === "merge")).toHaveLength(1);
  });

  it("reprise après l'attente (déjà émis) : comportement habituel, les deux sont émis", async () => {
    const h = holdSetup({ 12: "start", 30: "end", 40: "start", 60: "end" }, ["et puis", "et puis voilà"]);
    h.frames(35);
    await flush();
    h.tick(1200); h.fire();
    expect(h.transcripts()).toHaveLength(1);
    h.tick(300);
    h.frames(30);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(2));
  });

  it("« oui » n'est jamais retenu", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["oui"]);
    h.frames(50);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
    expect(h.armed()).toBe(false);
  });

  it("bouton parler : jamais retenu", async () => {
    const h = holdSetup({}, ["envoie ça à euh"]);
    h.s.ptt(true); h.frames(20); h.s.ptt(false);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
    expect(h.armed()).toBe(false);
  });

  it("0 désactive l'attente", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["envoie ça à euh"], 0);
    h.frames(50);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
  });

  it("pas de retenue pendant une coupure de parole (voix qui joue)", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["envoie ça à euh"]);
    h.s.setSpeaking(true);
    h.frames(50);
    await vi.waitFor(() => expect(h.transcripts()).toHaveLength(1));
  });

  it("la voix qui démarre pendant l'attente émet le texte retenu", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["envoie ça à euh"]);
    h.frames(50);
    await flush();
    expect(h.transcripts()).toHaveLength(0);
    h.s.setSpeaking(true);
    expect(h.transcripts()).toHaveLength(1);
  });

  it("fermeture pendant l'attente : abandon propre, minuteur nettoyé, rien d'émis", async () => {
    const h = holdSetup({ 12: "start", 40: "end" }, ["envoie ça à euh"]);
    h.frames(50);
    await flush();
    expect(h.armed()).toBe(true);
    h.s.close();
    expect(h.armed()).toBe(false);
    h.fire();
    expect(h.transcripts()).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: "closed" });
  });
});

describe("looksUnfinished", () => {
  it("français : mots de liaison, hésitations, points de suspension, virgule", () => {
    for (const t of ["envoie ça à", "envoie ça à euh", "je voudrais un", "mets le rappel pour demain et", "bon alors,", "je ne sais pas…", "je ne sais pas...", "donne-moi l'", "bon euh."]) expect(looksUnfinished(t), t).toBe(true);
  });
  it("anglais : liaisons, hésitations", () => {
    for (const t of ["send this to", "send it to uh", "I want to talk about the", "well um", "and then,", "wait for it..."]) expect(looksUnfinished(t), t).toBe(true);
  });
  it("phrases complètes et mots seuls : non", () => {
    for (const t of ["", "oui", "non", "stop", "ok", "Oui.", "euh", "envoie ça à Paul", "quelle heure est-il ?", "arrête !", "c'est fait.", "send it to Paul.", "I think so.", "et"]) expect(looksUnfinished(t), t).toBe(false);
  });
});
