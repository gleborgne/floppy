import { afterEach, describe, expect, it, vi } from "vitest";
import { Kernel, MemorySecrets, connectJsonSocket, definePlugin } from "@floppy/core";
import type { LiveService, TtsService, LiveEvent } from "@floppy/contracts";
import elevenlabs from "@floppy/plugin-tts-elevenlabs";
import geminiTts from "@floppy/plugin-tts-gemini";
import geminiLive from "@floppy/plugin-live-gemini";
import openaiLive from "@floppy/plugin-live-openai";

const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static OPEN = 1; static CLOSED = 3;
    readyState = 0; bufferedAmount = 0; sent: any[] = [];
    url: string; options: unknown;
    constructor(url: string, options: unknown) { super(); this.url = url; this.options = options; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit("open"); }); }
    send(data: string) {
      const event = JSON.parse(data); this.sent.push(event);
      if (event.setup) queueMicrotask(() => this.receive({ setupComplete: {} }));
      if (event.type === "session.start") queueMicrotask(() => this.receive({ type: "session.started" }));
      if (event.type === "session.close") queueMicrotask(() => this.receive({ type: "session.closed" }));
    }
    receive(event: unknown) { this.emit("message", Buffer.from(JSON.stringify(event))); }
    close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit("close")); }
    terminate() { this.close(); }
  }
  return { default: FakeSocket };
});

afterEach(() => { vi.unstubAllGlobals(); sockets.length = 0; });
const values = async (service: TtsService) => {
  const chunks = [];
  for await (const c of service.speak!("Bonjour", { signal: new AbortController().signal })) chunks.push(...c.pcm);
  return chunks;
};
/** Les comptes cloud sont offerts (élément « account ») : un consommateur avec un slot les met en service. */
function consumer<T>(service: "tts" | "live") {
  const holder: { svc?: T } = {};
  const plugin = definePlugin({
    manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: `test.${service}`, service, section: "x", label: "x", none: "aucun" }] },
    async apply(ctx) { holder.svc = await ctx.slot<T>(`test.${service}`); },
  });
  return { plugin, holder, entry: { id: "consumer", plugin: "consumer" } };
}

describe("fournisseurs TTS : contrat réseau", () => {
  it("ElevenLabs demande du PCM, conserve les octets coupés et ne publie jamais sa clé", async () => {
    const secrets = new MemorySecrets(); secrets.set("tts-elevenlabs/eleven/apiKey", "secret-test");
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.enqueue(new Uint8Array([0, 255, 127])); c.close(); } })));
    vi.stubGlobal("fetch", fetch);
    const c = consumer<TtsService>("tts");
    const k = new Kernel({ logger: () => {}, secrets, plugins: [elevenlabs, c.plugin] });
    try {
      await k.applyConfig({ plugins: [{ id: "eleven", plugin: "tts-elevenlabs", config: { voice: "voice-id" } }, c.entry] });
      expect(c.holder.svc).toBeUndefined();
      expect((await k.settings.change("slot.test.tts", "eleven/account", "ui")).ok).toBe(true);
      expect(await values(c.holder.svc!)).toEqual([1, 32767]);
      expect(fetch.mock.calls[0]?.[0]).toContain("voice-id/stream?output_format=pcm_24000");
      expect(JSON.stringify(await k.items.snapshot())).not.toContain("secret-test");
    } finally { await k.stopAll(); }
  });
  it("Gemini décode les parties audio SSE ; une réponse sans audio devient une erreur visible", async () => {
    const secrets = new MemorySecrets(); secrets.set("tts-gemini/gemini/apiKey", "secret-test");
    const chunk = { candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.from([1, 0, 2, 0]).toString("base64") } }] } }] };
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(chunk)}\n\n`));
    vi.stubGlobal("fetch", fetch);
    const c = consumer<TtsService>("tts");
    const k = new Kernel({ logger: () => {}, secrets, plugins: [geminiTts, c.plugin] });
    try {
      await k.applyConfig({ plugins: [{ id: "gemini", plugin: "tts-gemini" }, c.entry], slots: { "test.tts": "gemini/account" } });
      expect(await values(c.holder.svc!)).toEqual([1, 2]);
      fetch.mockImplementation(async () => new Response(`data: ${JSON.stringify({ candidates: [{ ...chunk.candidates[0], finishReason: "OTHER" }] })}\n\n`));
      await expect(values(c.holder.svc!)).rejects.toThrow(/interrompue/);
      fetch.mockImplementation(async () => new Response('data: {"candidates":[]}\n\n'));
      await expect(values(c.holder.svc!)).rejects.toThrow(/aucun audio/);
    } finally { await k.stopAll(); }
  });
  it("une clé manquante échoue avant tout appel réseau", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const c = consumer<TtsService>("tts");
    const k = new Kernel({ logger: () => {}, plugins: [geminiTts, c.plugin] });
    try {
      await k.applyConfig({ plugins: [{ id: "g", plugin: "tts-gemini" }, c.entry], slots: { "test.tts": "g/account" } });
      // Sans clé, la voix ne démarre pas : panne visible sur le slot, rien n'est mis en service.
      expect(c.holder.svc).toBeUndefined();
      expect(k.slots().find((x) => x.id === "test.tts")).toMatchObject({ state: "error", error: expect.stringContaining("Clé API") });
      await k.settings.change("slot.test.tts", "@none", "ui");
      const selection = await k.settings.change("slot.test.tts", "g/account", "ui");
      expect(selection).toMatchObject({ ok: false });
      expect(selection.text).toContain("Clé API");
      expect(c.holder.svc).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await k.stopAll(); }
  });
});

describe("fournisseurs Live : contrat WebSocket", () => {
  it("conserve la cause de fermeture du fournisseur en masquant la clé", async () => {
    const closed = vi.fn();
    const socket = await connectJsonSocket({ url: "wss://example.test/?key=private-key", start: { setup: {} }, signal: new AbortController().signal, ready: e => !!e.setupComplete, on: () => {}, closed });
    sockets[0].emit("close", 1008, Buffer.from("Invalid model; key=private-key"));
    expect(closed).toHaveBeenCalledWith(expect.stringContaining("1008"), expect.objectContaining({ en: expect.stringContaining("1008") }));
    expect(closed).toHaveBeenCalledWith(expect.stringContaining("Invalid model"), expect.anything());
    expect(closed.mock.calls[0]![1].en).toMatch(/^Provider connection closed/);
    expect(JSON.stringify(closed.mock.calls)).not.toContain("private-key");
    await socket.close();
  });
  it("Gemini : handshake avant micro, outils avec leurs identifiants, PCM 24 kHz et fermeture", async () => {
    const secrets = new MemorySecrets(); secrets.set("live-gemini/gemini/apiKey", "secret-test");
    const c = consumer<LiveService>("live");
    const k = new Kernel({ logger: () => {}, secrets, plugins: [geminiLive, c.plugin] });
    const events: LiveEvent[] = [];
    try {
      await k.applyConfig({ plugins: [{ id: "gemini", plugin: "live-gemini" }, c.entry], slots: { "test.live": "gemini/account" } });
      const service = c.holder.svc!;
      const session = await service.open({ body: "avatar", instructions: "bonjour", tools: [], signal: new AbortController().signal, on: (e) => events.push(e) });
      const ws = sockets[0]!;
      expect(ws.sent[0].setup.model).toBe("models/gemini-3.8-live");
      session.pushAudio(new Float32Array([0.5]));
      expect(ws.sent[1].realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
      ws.receive({ toolCall: { functionCalls: [{ id: "call", name: "agenda", args: {} }] } });
      expect(events.at(-1)).toEqual({ type: "tool_call", id: "call", name: "agenda", args: {}, generation: 0 });
      session.toolResult!("call", "agenda", { text: "rien", status: "done" });
      expect(ws.sent.at(-1).toolResponse.functionResponses[0].id).toBe("call");
      ws.receive({ serverContent: { outputTranscription: { text: "Bonjour." }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AQA=" } }] } } });
      expect(events.at(-2)).toEqual({ type: "output_transcript", text: "Bonjour.", final: false, generation: 0 });
      expect(events.at(-1)).toMatchObject({ type: "audio", rate: 24000, pcm: new Int16Array([1]) });
      ws.receive({ serverContent: { interrupted: true } });
      expect(events.at(-1)).toEqual({ type: "interrupted", generation: 1 });
      ws.receive({ serverContent: { outputTranscription: { text: "Après." } } });
      expect(events.at(-1)).toMatchObject({ type: "output_transcript", generation: 1 });
      await session.close(); expect(ws.readyState).toBe(3);
    } finally { await k.stopAll(); }
  });
  it("GPT Live : délégation client, PCM16, appends bornés et confirmation de fermeture", async () => {
    const secrets = new MemorySecrets(); secrets.set("live-openai/gpt/apiKey", "secret-test");
    const c = consumer<LiveService>("live");
    const k = new Kernel({ logger: () => {}, secrets, plugins: [openaiLive, c.plugin] });
    const events: LiveEvent[] = [];
    try {
      await k.applyConfig({ plugins: [{ id: "gpt", plugin: "live-openai" }, c.entry], slots: { "test.live": "gpt/account" } });
      const session = await c.holder.svc!.open({ body: "avatar", instructions: "bonjour", tools: [], signal: new AbortController().signal, on: (e) => events.push(e) });
      const ws = sockets[0]!;
      expect(ws.url).toBe("wss://api.openai.com/v1/live/sessions");
      expect(ws.sent[0]).toMatchObject({ type: "session.start", session: { delegation: { type: "client" }, audio: { format: { rate: 16000 } } } });
      ws.receive({ type: "error", error: { client_event_id: "bad-command" } });
      expect(events.at(-1)).toMatchObject({ type: "error", fatal: false });
      expect(ws.readyState).toBe(1);
      ws.receive({ type: "session.delegation.created", delegation: { id: "task", target: "client" }, offset_ms: 100 });
      expect(events.at(-1)).toEqual({ type: "delegation", id: "task", offsetMs: 100 });
      session.append("say", "é".repeat(600), "task");
      const updates = ws.sent.filter((e: any) => e.type === "session.commentary.append");
      expect(updates.map((e: any) => e.content).join("")).toBe("é".repeat(600));
      expect(updates.every((e: any) => Buffer.byteLength(e.content) <= 480 && e.delegation_id === "task")).toBe(true);
      await session.close();
      expect(ws.sent.at(-1)).toEqual({ type: "session.close" }); expect(ws.readyState).toBe(3);
    } finally { await k.stopAll(); }
  });
});
