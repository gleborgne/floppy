import { describe, it, expect, vi } from "vitest";
import { Kernel, definePlugin, AudioHistory, type Context } from "@floppy/core";
import type { BodyHub, LiveService, LiveSession, LiveEvent, BrainRunInput } from "@floppy/contracts";
import type { KernelToBody } from "@floppy/protocol";
import { LiveConversation, liveInstructions } from "../src/live.ts";

async function fixture(kind: "function" | "delegation" = "function", timed = false) {
  let ctx!: Context;
  let events!: (e: LiveEvent) => void;
  const sent: KernelToBody[] = [], audio: Uint8Array[] = [], replay: number[] = [];
  const session: LiveSession = { pushAudio: (f) => replay.push(...f), sendText: vi.fn(), append: vi.fn(), toolResult: vi.fn(), close: vi.fn(async () => {}) };
  const service: LiveService = { name: "fake", capabilities: { tools: kind }, open: vi.fn(async (o) => { events = o.on; return session; }) };
  const order: string[] = [];
  const hub: BodyHub = { send: (_, m) => { sent.push(m); order.push(m.type); }, sendAudio: (_, data) => { audio.push(data); order.push("audio"); }, attach: () => {}, sessions: () => [], has: (_, cap) => timed && cap === "speech_timing", broadcast: () => {}, on: () => () => {} };
  const provider = definePlugin({ manifest: { id: "body", version: "0", licence: "MIT", provides: ["body"] }, apply(c) { c.provide("body", hub); } });
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["body"], optional: ["memory"], permissions: { approvals: "respond" } }, apply(c) { ctx = c; } });
  const k = new Kernel({ logger: () => {}, plugins: [provider, probe] });
  await k.applyConfig({ approvals: { timeout_s: 5 }, plugins: [{ id: "body", plugin: "body" }, { id: "probe", plugin: "probe" }] });
  const history = new AudioHistory(); history.push(new Float32Array([10, 11, 12, 13, 14]));
  const run = vi.fn(async function* (_input: BrainRunInput) { yield { type: "text" as const, delta: "Résultat confirmé." }; });
  const input = vi.fn();
  const reply = vi.fn((_text: string, _timing: { body: string; id: string }): string | undefined => undefined);
  let profile: "playful" | "discreet" = "playful";
  const states: string[] = [];
  const live = new LiveConversation({ ctx, body: "avatar", service, brain: { name: "fake", reset: () => {}, run }, history,
    tone: () => "sobre", profile: () => profile, freeListen: () => 1, onInput: input, onReply: reply, onState: (s) => states.push(s), onPlaying: () => {} });
  return { k, service, session, live, audio, sent, history, run, input, reply, order, replay, states, setProfile: (p: typeof profile) => { profile = p; live.updateTone(); }, emit: (e: LiveEvent) => events(e) };
}

describe("conversation Live", () => {
  it.each(["function", "delegation"] as const)("aligne le texte sur le prochain bloc %s sans retarder le son", async (kind) => {
    const f = await fixture(kind, true);
    try {
      await f.live.start(0, 5);
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array(2400) });
      expect(f.audio).toHaveLength(1); expect(f.reply).not.toHaveBeenCalled();
      f.emit({ type: "output_transcript", generation: 0, text: "Parce que la lumière traverse les gouttes.", final: false });
      expect(f.reply).not.toHaveBeenCalled();
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array(2400) });
      expect(f.reply).toHaveBeenCalledWith(expect.stringContaining("lumière"), { body: "avatar", id: expect.any(String) });
      expect(f.sent).toContainEqual({ type: "speech.gesture", intent: "explain", intensity: 1, nextAudio: expect.any(String) });
      expect(f.order.slice(-2)).toEqual(["speech.gesture", "audio"]);
      f.emit({ type: "output_transcript", generation: 0, text: "Et ensuite ?", final: false });
      f.emit({ type: "generation_done" });
      f.emit({ type: "audio", generation: 1, rate: 24000, pcm: new Int16Array(2400) });
      expect(f.reply).toHaveBeenCalledOnce(); // le reliquat ne colore pas la réponse suivante
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("rejette aussi les transcriptions et gestes d'une génération interrompue", async () => {
    const f = await fixture("function", true);
    try {
      await f.live.start(0, 5);
      f.emit({ type: "audio", generation: 3, rate: 24000, pcm: new Int16Array(2400) });
      f.emit({ type: "output_transcript", generation: 3, text: "Parce que", final: false });
      f.live.bargeIn(); f.sent.length = 0;
      f.emit({ type: "output_transcript", generation: 3, text: "Ancien texte ?", final: false });
      f.emit({ type: "output_transcript", text: "Ancien texte sans époque ?", final: false });
      f.emit({ type: "audio", generation: 4, rate: 24000, pcm: new Int16Array(2400) });
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.sent.some(m => m.type === "speech.gesture" || m.type === "reply.delta")).toBe(false);
      f.setProfile("discreet");
      expect(f.session.append).toHaveBeenLastCalledWith("instruct", expect.stringContaining("Expression vocale discrète"));
      f.emit({ type: "output_transcript", generation: 4, text: "Peut-être ?", final: false });
      f.emit({ type: "audio", generation: 4, rate: 24000, pcm: new Int16Array(2400) });
      expect(f.sent).toContainEqual({ type: "speech.gesture", intent: "question", intensity: 0.45, nextAudio: expect.any(String) });
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("les consignes Live restent conversationnelles, bilingues et respectent les accords", () => {
    const fr = liveInstructions({ name: "Floppy", language: "fr", tone: "amical", recent: [] });
    const en = liveInstructions({ name: "Floppy", language: "en", tone: "friendly", recent: [], profile: "discreet" });
    expect(fr).toContain("malice amicale"); expect(fr).toContain("sans sarcasme");
    expect(en).toContain("Understated vocal expression"); expect(en).toContain("never tools or approvals");
    expect(fr).not.toContain("uniquement le texte fourni");
  });
  it("réunit les petits fragments, ignore les repères trop vieux et ne les transmet pas aux anciens corps", async () => {
    const f = await fixture("function", true), legacy = await fixture();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000); await f.live.start(0, 5); await legacy.live.start(0, 5);
      const audio = { type: "audio" as const, generation: 0, rate: 24000, pcm: new Int16Array(2400) };
      f.emit({ type: "output_transcript", generation: 0, text: "Parce ", final: false }); f.emit(audio);
      f.emit({ type: "output_transcript", generation: 0, text: "que la lumière", final: false }); f.emit(audio);
      f.emit({ type: "output_transcript", generation: 0, text: " traverse les gouttes", final: false }); f.emit(audio);
      expect(f.sent.filter(m => m.type === "speech.gesture")).toHaveLength(1);
      expect(f.sent).toContainEqual(expect.objectContaining({ type: "speech.gesture", intent: "explain" }));
      f.emit({ type: "output_transcript", generation: 0, text: "Peut-être ?", final: false });
      clock.mockReturnValue(2300); f.emit(audio);
      expect(f.reply).toHaveBeenCalledTimes(3);
      legacy.emit({ type: "output_transcript", text: "Parce que.", final: false }); legacy.emit(audio);
      expect(legacy.reply).toHaveBeenCalledOnce(); expect(legacy.sent.some(m => m.type === "speech.gesture")).toBe(false);
    } finally { clock.mockRestore(); await f.live.stop("test"); await legacy.live.stop("test"); await f.k.stopAll(); await legacy.k.stopAll(); }
  });
  it("coupe localement avant le fournisseur et rejette les blocs de la réponse interrompue", async () => {
    const f = await fixture();
    try {
      await f.live.start(0, 5);
      f.emit({ type: "audio", generation: 3, rate: 24000, pcm: new Int16Array(24000) });
      f.live.bargeIn();
      expect(f.sent).toContainEqual({ type: "interrupt" });
      expect(f.states.at(-1)).toBe("listening");
      f.emit({ type: "audio", generation: 3, rate: 24000, pcm: new Int16Array(24000) });
      expect(f.audio).toHaveLength(1);
      f.emit({ type: "interrupted", generation: 4 });
      f.emit({ type: "audio", generation: 4, rate: 24000, pcm: new Int16Array(24000) });
      expect(f.audio).toHaveLength(2);
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("une demande écrite ouvre Live sans rejouer le micro et conserve le contexte", async () => {
    const f = await fixture();
    try {
      await f.live.requestText("Bonjour.");
      expect(f.session.sendText).toHaveBeenCalledWith("Bonjour.");
      expect(f.replay).toEqual([]);
      expect(f.sent).toContainEqual({ type: "transcript", text: "Bonjour.", final: true });
      f.emit({ type: "output_transcript", text: "Salut.", final: true });
      await f.live.requestText("Et ensuite ?");
      expect(f.session.close).toHaveBeenCalledOnce();
      expect(vi.mocked(f.service.open).mock.calls[1]![0].instructions).toContain("Salut.");
      expect(f.session.sendText).toHaveBeenLastCalledWith("Et ensuite ?");
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("GPT traite le texte par sa délégation habituelle avec le même corps et le mode vocal", async () => {
    const f = await fixture("delegation");
    try {
      await f.live.requestText("Ouvre le document.");
      await vi.waitFor(() => expect(f.session.append).toHaveBeenCalledWith("say", "Résultat confirmé.", expect.any(String)));
      expect(f.run.mock.calls[0]![0]).toMatchObject({ text: "Ouvre le document.", session: "avatar", origin: "avatar", mode: "voice" });
      expect(f.replay).toEqual([]);
      expect(f.session.sendText).not.toHaveBeenCalled();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("sérialise deux délégations et conserve leurs demandes distinctes", async () => {
    const f = await fixture("delegation");
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    f.run.mockImplementation(async function* (input) { if (input.text === "Première.") await wait; yield { type: "text", delta: input.text }; });
    try {
      await f.live.start(0, 5);
      f.emit({ type: "input_transcript", text: "Première.", final: false, startMs: 0, endMs: 100 });
      f.emit({ type: "delegation", id: "one", offsetMs: 100 });
      f.emit({ type: "input_transcript", text: "Deuxième.", final: false, startMs: 1000, endMs: 1100 });
      f.emit({ type: "delegation", id: "one", offsetMs: 100 }); // doublon tardif, ne consomme pas le nouveau texte
      f.emit({ type: "delegation", id: "two", offsetMs: 1100 });
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
      release();
      await vi.waitFor(() => expect(f.session.append).toHaveBeenCalledTimes(2));
      expect(vi.mocked(f.session.append).mock.calls.map((c) => [c[1], c[2]])).toEqual([["Première.", "one"], ["Deuxième.", "two"]]);
    } finally { release(); await f.live.stop("test"); await f.k.stopAll(); }
  });
  it.each([true, false])("accord Gemini pendant la lecture : réponse %s conservée", async (answer) => {
    const f = await fixture();
    const handler = vi.fn(async () => ({ status: "done" as const, text: "fait" }));
    f.k.tools.register("test", [{ name: "write", description: "écrire", inputSchema: {}, level: "write", handler }]);
    f.k.bus.on("approval.request", () => f.live.beginApproval());
    try {
      await f.live.start(0, 5);
      f.emit({ type: "tool_call", id: "call", name: "write", args: {} });
      await vi.waitFor(() => expect(f.k.approvals.pending()).toHaveLength(1));
      expect(f.session.append).not.toHaveBeenCalled(); // aucun faux tour utilisateur
      f.live.playback(true);
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array([1]) });
      expect(f.audio).toHaveLength(1); // seulement le signal local d'accord
      f.live.bargeIn();
      f.k.approvals.respond(f.k.approvals.pending()[0]!.id, answer, "voix");
      await vi.waitFor(() => expect(f.session.toolResult).toHaveBeenCalled());
      expect(handler).toHaveBeenCalledTimes(answer ? 1 : 0);
      expect(f.live.active).toBe(true);
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("reprend GPT sur une nouvelle socket après l'accord sans perdre le résultat confirmé", async () => {
    const f = await fixture("delegation");
    f.k.bus.on("approval.request", () => f.live.beginApproval());
    f.k.tools.register("test", [{ name: "write", description: "écrire", inputSchema: {}, level: "write", handler: async () => ({ status: "done", text: "Écriture confirmée." }) }]);
    f.run.mockImplementation(async function* (input) {
      const result = await f.k.tools.call("write", {}, { origin: input.origin, signal: input.signal });
      yield { type: "text", delta: result.text };
    });
    try {
      await f.live.start(0, 5);
      f.emit({ type: "input_transcript", text: "Écris.", final: false, startMs: 0, endMs: 100 });
      f.emit({ type: "delegation", id: "one", offsetMs: 100 });
      await vi.waitFor(() => expect(f.k.approvals.pending()).toHaveLength(1));
      f.live.bargeIn();
      f.k.approvals.respond(f.k.approvals.pending()[0]!.id, true, "voix");
      await vi.waitFor(() => expect(f.service.open).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(f.session.append).toHaveBeenCalledWith("say", "Écriture confirmée."));
      expect(f.run).toHaveBeenCalledOnce();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("fin de lecture GPT : revient à l'écoute et une parole suivante ne ferme pas la session", async () => {
    const f = await fixture("delegation");
    try {
      await f.live.start(0, 5);
      f.emit({ type: "output_transcript", text: "Bonjour.", final: false });
      f.emit({ type: "audio", generation: 0, rate: 16000, pcm: new Int16Array([1]) });
      f.live.playback(false);
      expect(f.states.at(-1)).toBe("listening");
      f.live.bargeIn();
      expect(f.live.active).toBe(true);
      expect(f.session.close).not.toHaveBeenCalled();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("ne rejoue pas la première demande dans la deuxième délégation", async () => {
    const f = await fixture("delegation");
    try {
      await f.live.start(0, 5);
      f.emit({ type: "input_transcript", text: "Ouvre le site.", final: false, startMs: 0, endMs: 100 });
      f.emit({ type: "delegation", id: "one", offsetMs: 100 });
      await vi.waitFor(() => expect(f.session.append).toHaveBeenCalledOnce());
      f.emit({ type: "input_transcript", text: "Envoie le mail.", final: false, startMs: 1000, endMs: 1100 });
      f.emit({ type: "delegation", id: "two", offsetMs: 1100 });
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
      expect(f.run.mock.calls[1]?.[0]).toMatchObject({ text: "Envoie le mail." });
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("un oui déjà traité par l'accord ne devient pas une nouvelle action GPT", async () => {
    const f = await fixture("delegation");
    try {
      await f.live.start(0, 5);
      f.emit({ type: "input_transcript", text: "Écris.", final: false, startMs: 0, endMs: 100 });
      f.emit({ type: "delegation", id: "one", offsetMs: 100 });
      await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
      f.live.noteApprovalReply("oui");
      f.emit({ type: "input_transcript", text: "Oui.", final: false, startMs: 1000, endMs: 1100 });
      f.emit({ type: "delegation", id: "two", offsetMs: 1100 });
      await new Promise<void>((r) => setImmediate(r));
      expect(f.run).toHaveBeenCalledOnce();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("l'expiration d'un accord Gemini rend un refus sans exécuter l'action", async () => {
    const f = await fixture();
    const handler = vi.fn(async () => ({ status: "done" as const, text: "fait" }));
    f.k.tools.register("test", [{ name: "write", description: "écrire", inputSchema: {}, level: "write", handler }]);
    f.k.bus.on("approval.request", () => f.live.beginApproval());
    vi.useFakeTimers();
    try {
      await f.live.start(0, 5);
      f.emit({ type: "tool_call", id: "one", name: "write", args: {} });
      await vi.advanceTimersByTimeAsync(5001);
      expect(f.k.approvals.pending()).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();
      expect(f.session.toolResult).toHaveBeenCalledWith("one", "write", expect.objectContaining({ status: "refused" }));
      expect(f.live.active).toBe(true);
    } finally { vi.useRealTimers(); await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("l'échec tardif d'une ouverture annulée ne ferme pas sa remplaçante", async () => {
    const f = await fixture();
    let reject!: (e: Error) => void;
    vi.mocked(f.service.open).mockImplementationOnce(() => new Promise((_, ko) => { reject = ko; }));
    try {
      const first = f.live.start(0, 5);
      await vi.waitFor(() => expect(reject).toBeDefined());
      await f.live.stop("muet");
      await f.live.start(0, 5);
      reject(new Error("Connexion annulée"));
      await first.catch(() => {});
      expect(f.live.active).toBe(true);
      expect(f.session.close).not.toHaveBeenCalled();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("un barge-in pendant l'accord garde la tâche et permet la réponse vocale", async () => {
    const f = await fixture("delegation");
    const handler = vi.fn(async () => ({ status: "done" as const, text: "fait" }));
    f.k.tools.register("test", [{ name: "write", description: "écrire", inputSchema: {}, level: "write", handler }]);
    try {
      await f.live.start(0, 5);
      f.emit({ type: "tool_call", id: "a", name: "write", args: {} });
      await vi.waitFor(() => expect(f.k.approvals.pending()).toHaveLength(1));
      f.emit({ type: "audio", generation: 0, rate: 16000, pcm: new Int16Array([1]) });
      f.live.bargeIn();
      expect(f.live.active).toBe(true);
      expect(f.k.approvals.pending()).toHaveLength(1);
      f.input.mockImplementation((text) => { if (text === "oui") f.k.approvals.respond(f.k.approvals.pending()[0]!.id, true, "voix"); });
      f.live.localTranscript("oui");
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("ferme après l'écoute libre même sans retour playback du corps", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    try {
      await f.live.start(0, 5);
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array([1]) });
      await vi.advanceTimersByTimeAsync(4000);
      expect(f.live.active).toBe(false);
    } finally { vi.useRealTimers(); await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("ne transmet rien avant activation puis rejoue seulement l'énoncé et les trames suivantes", async () => {
    const f = await fixture();
    try {
      f.live.pushAudio(new Float32Array([100]));
      expect(f.service.open).not.toHaveBeenCalled();
      await f.live.start(2, 5, "Floppy bonjour");
      f.live.pushAudio(new Float32Array([15]));
      expect(f.service.open).toHaveBeenCalledOnce();
      // L'historique antérieur [10,11] n'a pas quitté le PC.
      expect(f.replay).toEqual([12, 13, 14, 15]);
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array([1]) });
      expect(f.audio).toHaveLength(1);
      await f.live.stop("muet");
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array([2]) });
      expect(f.audio).toHaveLength(1);
      expect(f.session.close).toHaveBeenCalledOnce();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("refuse une activation dont l'audio a été effacé", async () => {
    const f = await fixture();
    try {
      f.history.clear();
      await expect(f.live.start(0, 5)).rejects.toThrow(/tampon/);
      expect(f.service.open).not.toHaveBeenCalled();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("purge l'ancienne génération à l'interruption Gemini", async () => {
    const f = await fixture();
    try {
      await f.live.start(0, 5);
      f.emit({ type: "interrupted", generation: 1 });
      f.emit({ type: "audio", generation: 0, rate: 24000, pcm: new Int16Array([1]) });
      expect(f.audio).toHaveLength(0);
      f.emit({ type: "audio", generation: 1, rate: 24000, pcm: new Int16Array([2]) });
      expect(f.audio).toHaveLength(1);
      expect(f.sent.some((e) => e.type === "interrupt")).toBe(true);
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("un appel d'outil Live attend l'accord et une fermeture annule cet accord", async () => {
    const f = await fixture();
    const handler = vi.fn(async () => ({ status: "done" as const, text: "fait" }));
    f.k.tools.register("test", [{ name: "write", description: "écrire", inputSchema: {}, level: "write", handler }]);
    try {
      await f.live.start(0, 5);
      f.emit({ type: "tool_call", id: "a", name: "write", args: {} });
      await vi.waitFor(() => expect(f.k.approvals.pending()).toHaveLength(1));
      expect(f.k.approvals.pending()[0]!.origin).toBe("avatar");
      f.k.approvals.respond(f.k.approvals.pending()[0]!.id, true, "test");
      await vi.waitFor(() => expect(f.session.toolResult).toHaveBeenCalledWith("a", "write", { status: "done", text: "fait" }));
      f.emit({ type: "tool_call", id: "a", name: "write", args: {} }); // doublon réseau
      expect(handler).toHaveBeenCalledOnce();
      f.emit({ type: "tool_call", id: "b", name: "write", args: {} });
      await vi.waitFor(() => expect(f.k.approvals.pending()).toHaveLength(1));
      await f.live.stop("déconnexion");
      expect(f.k.approvals.pending()).toHaveLength(0);
      expect(handler).toHaveBeenCalledOnce();
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
  it("GPT Live délègue le contexte transcrit au cerveau et renvoie le résultat avec son identifiant", async () => {
    const f = await fixture("delegation");
    try {
      await f.live.start(0, 5);
      f.emit({ type: "input_transcript", text: "Ouvre ", final: false, startMs: 0, endMs: 100 });
      f.emit({ type: "input_transcript", text: "le site.", final: false, startMs: 100, endMs: 200 });
      f.emit({ type: "delegation", id: "task-1", offsetMs: 250 });
      await vi.waitFor(() => expect(f.session.append).toHaveBeenCalledWith("say", "Résultat confirmé.", "task-1"));
      expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ text: "Ouvre le site.", origin: "avatar", mode: "voice" }));
    } finally { await f.live.stop("test"); await f.k.stopAll(); }
  });
});
