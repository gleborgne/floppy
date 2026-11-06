// Test de bout en bout de l'orchestration (sans GPU) : faux cerveau, fausse voix, 2 corps en mémoire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Kernel, definePlugin, type BrainService, type VoiceEvent, type VoiceService, type VoiceStream, type LiveService, type LiveEvent, type WakewordService, type WakewordDetection } from "@floppy/core";
import type { BodyToKernel, BodyTransport, KernelToBody, Capability, BodyToolDecl } from "@floppy/protocol";
import bodyHub from "@floppy/plugin-body-hub";
import wakewordStt from "@floppy/plugin-wakeword-stt";
import conversation, { SentenceSplitter, yesNo, hasWakeWord, stripWakeWord, matchQuickSetting, isSleepCommand, isWakeUpPhrase, liveInstructions, guessEmotion } from "../src/index.ts";

// ------------------------------------------------------------------ corps de test en mémoire
class FakeBody {
  got: KernelToBody[] = [];
  /** Nombre de blocs audio déjà reçus au moment de chaque message (ordre voix / émotion). */
  audioAt: number[] = [];
  audio = 0;
  private onMsg?: (m: BodyToKernel) => void;
  private onClose?: () => void;
  private onFrame?: (f: Float32Array) => void;
  transport: BodyTransport = {
    send: (m) => { this.got.push(m); this.audioAt.push(this.audio); if (m.type === "tool.call") this.onToolCall(m); },
    sendAudio: () => { this.audio++; },
    onMessage: (fn) => { this.onMsg = fn; },
    onAudio: (fn) => { this.onFrame = fn; },
    onClose: (fn) => { this.onClose = fn; },
    close: () => this.onClose?.(),
  };
  onToolCall: (m: Extract<KernelToBody, { type: "tool.call" }>) => void = () => {};
  id: string;
  caps: Capability[];
  tools: BodyToolDecl[];
  constructor(id: string, caps: Capability[], tools: BodyToolDecl[] = []) { this.id = id; this.caps = caps; this.tools = tools; }
  hello() { this.send({ type: "hello", id: this.id, name: this.id, version: "0", capabilities: this.caps, tools: this.tools }); }
  send(m: BodyToKernel) { this.onMsg!(m); }
  feed(frame: Float32Array) { this.onFrame?.(frame); }
  of<T extends KernelToBody["type"]>(t: T) { return this.got.filter((m) => m.type === t) as Extract<KernelToBody, { type: T }>[]; }
  leave() { this.onClose?.(); }
}

// ------------------------------------------------------------------ fausse voix
const streams = new Map<string, { emit: (e: VoiceEvent) => void; spoken: string[]; cancelled: number }>();
describe("contrat wakeword dans la conversation", () => {
  async function fixture(opts: { voice?: boolean; cascade?: boolean; missing?: boolean } = {}) {
    const detectors: { detect(d: WakewordDetection): void; close: ReturnType<typeof vi.fn>; signal: AbortSignal }[] = [];
    const changes = new Set<() => void>();
    const pushed: number[] = [];
    const wake = definePlugin({ manifest: { id: "custom-detector", version: "0", licence: "MIT", provides: ["wakeword"] }, apply(c) {
      const svc = { name: "N'importe quel moteur", availability: () => ({ ready: true }), onChange(fn: () => void) { changes.add(fn); return () => { changes.delete(fn); }; }, async open(o: Parameters<WakewordService["open"]>[0]) {
        const detector = { detect: o.onDetection, close: vi.fn(), signal: o.signal };
        detectors.push(detector); return { pushAudio() {}, close: detector.close };
      } } satisfies WakewordService;
      c.offer("wakeword", { items: () => [{ id: "account", label: "Détecteur" }], start(f) { f.provide("wakeword", svc); } });
    } });
    const open = vi.fn(async () => ({ pushAudio: (f: Float32Array) => pushed.push(...f), toolResult() {}, append() {}, close: async () => {} }));
    const live = definePlugin({ manifest: { id: "wake-live", version: "0", licence: "MIT", provides: ["live"] }, apply(c) {
      c.offer("live", { items: () => [{ id: "x", label: "Live" }], start(f) { f.provide("live", { name: "test", capabilities: { tools: "function" }, open }); } });
    } });
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, conversation, fakeBrain, fakeVoice, wake, live, wakewordStt] });
    await k.applyConfig({ slots: { "listen.wakeword": opts.missing ? "absent/account" : "wake/account", "conversation.live": opts.cascade ? "@none" : "live/x" }, plugins: [
      { id: "body", plugin: "body-hub" }, { id: "wake", plugin: "custom-detector" }, { id: "brain", plugin: "fake-brain" },
      { id: "stt", plugin: "wakeword-stt" },
      ...(!opts.cascade ? [{ id: "live", plugin: "wake-live" }] : []),
      ...(opts.voice ? [{ id: "voice", plugin: "fake-voice" }] : []), { id: "conv", plugin: "conversation" },
    ] });
    const avatar = new FakeBody("wake-avatar", ["voice", "display", "emotion"]);
    k.service<import("@floppy/core").BodyHub>("body")!.attach(avatar.transport, { id: avatar.id }); avatar.hello();
    await vi.waitFor(() => expect(opts.missing ? avatar.of("error").length : detectors.length).toBeGreaterThan(0));
    return { k, avatar, detectors, changes, open, pushed };
  }
  it("un moteur tiers ouvre Live avant toute transcription, sans STT, et conserve le début de la demande", async () => {
    const f = await fixture();
    try {
      f.avatar.feed(new Float32Array([1, 2, 3]));
      expect(f.open).not.toHaveBeenCalled();
      f.detectors[0]!.detect({ word: "Marvin", startSample: 1, endSample: 3 });
      f.avatar.feed(new Float32Array([4, 5]));
      await vi.waitFor(() => expect(f.pushed).toEqual([2, 3, 4, 5]));
      expect(f.open).toHaveBeenCalledOnce();
      f.avatar.send({ type: "mute", on: true });
      f.avatar.feed(new Float32Array([6, 7]));
      f.detectors[0]!.detect({ word: "Marvin", startSample: 0, endSample: 7 });
      await vi.waitFor(() => expect(f.pushed).toEqual([2, 3, 4, 5, 6, 7])); // pas d'audio antérieur à la veille
    } finally { await f.k.stopAll(); }
  });
  it("avec un moteur choisi, la transcription ne le contourne pas ; le mode transcription reste sélectionnable", async () => {
    const f = await fixture({ voice: true });
    try {
      f.avatar.feed(new Float32Array([1, 2]));
      streams.get(f.avatar.id)!.emit({ type: "transcript", text: "Floppy bonjour", start_sample: 0, end_sample: 2, audio_s: 1, stt_ms: 0, merged: false });
      expect(f.open).not.toHaveBeenCalled();
      await f.k.settings.change("slot.listen.wakeword", "stt/account", "ui");
      await vi.waitFor(() => expect(f.detectors[0]!.close).toHaveBeenCalled());
      await new Promise<void>(r => setImmediate(r));
      f.avatar.feed(new Float32Array([3, 4]));
      streams.get(f.avatar.id)!.emit({ type: "transcript", text: "Floppy bonjour", start_sample: 0, end_sample: 2, audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
      expect(f.avatar.of("cue").map((c) => c.cue)).toContain("wake"); // aussi avec le mot trouvé dans la transcription
    } finally { await f.k.stopAll(); }
  });
  it("reconfigure le détecteur actif et ignore ses anciens rappels, puis ferme à la déconnexion", async () => {
    const f = await fixture();
    try {
      f.avatar.feed(new Float32Array([1, 2]));
      for (const change of f.changes) change();
      await vi.waitFor(() => expect(f.detectors).toHaveLength(2));
      expect(f.detectors[0]!.signal.aborted).toBe(true);
      f.detectors[0]!.detect({ word: "ancien", startSample: 0, endSample: 2 });
      expect(f.open).not.toHaveBeenCalled();
      f.avatar.leave();
      expect(f.detectors[1]!.close).toHaveBeenCalled();
      f.detectors[1]!.detect({ word: "ancien", startSample: 0, endSample: 2 });
      expect(f.open).not.toHaveBeenCalled();
    } finally { await f.k.stopAll(); }
  });
  it("en cascade, une détection autorise la demande transcrite même si le mot diffère des variantes STT", async () => {
    const f = await fixture({ voice: true, cascade: true });
    try {
      f.avatar.feed(new Float32Array([1, 2, 3, 4]));
      f.detectors[0]!.detect({ word: "Marvin", startSample: 0, endSample: 2 });
      expect(f.avatar.of("cue").map((c) => c.cue)).toContain("wake"); // réaction visible dès la détection
      expect(f.avatar.of("state").at(-1)).toMatchObject({ state: "listening" });
      streams.get(f.avatar.id)!.emit({ type: "transcript", text: "Marvin bonjour", start_sample: 0, end_sample: 4, audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(f.avatar.of("reply.done")).toHaveLength(1));
    } finally { await f.k.stopAll(); }
  });
  it("un fournisseur absent bloque le repli vocal silencieux mais laisse le bouton parler utilisable", async () => {
    const f = await fixture({ voice: true, missing: true });
    try {
      f.avatar.feed(new Float32Array([1, 2]));
      const transcript: VoiceEvent = { type: "transcript", text: "Floppy bonjour", start_sample: 0, end_sample: 2, audio_s: 1, stt_ms: 0, merged: false };
      streams.get(f.avatar.id)!.emit(transcript); expect(f.open).not.toHaveBeenCalled();
      f.avatar.send({ type: "ptt", on: true });
      streams.get(f.avatar.id)!.emit(transcript);
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    } finally { await f.k.stopAll(); }
  });
  it("sans plugin sélectionné, les mots STT ne déclenchent rien ; le bouton parle encore", async () => {
    const f = await fixture({ voice: true });
    try {
      await f.k.settings.change("slot.listen.wakeword", "@none", "ui");
      await new Promise<void>(r => setImmediate(r));
      f.avatar.feed(new Float32Array([1, 2]));
      const transcript: VoiceEvent = { type: "transcript", text: "Floppy bonjour", start_sample: 0, end_sample: 2, audio_s: 1, stt_ms: 0, merged: false };
      streams.get(f.avatar.id)!.emit(transcript); expect(f.open).not.toHaveBeenCalled();
      f.avatar.send({ type: "ptt", on: true });
      streams.get(f.avatar.id)!.emit(transcript);
      await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    } finally { await f.k.stopAll(); }
  });
});
describe("ressources du cerveau selon le mode vocal", () => {
  // Plus de setActive : le noyau démarre le cerveau (lazy) seulement si le mode le demande.
  it.each(["function", "delegation", "cascade"] as const)("%s : le cerveau tourne seulement si le mode en a besoin", async (kind) => {
    const brain = definePlugin({ manifest: { id: "runtime-brain", version: "0", licence: "MIT", provides: ["brain"], lazy: true }, apply(c) {
      c.provide("brain", { name: "test", reset() {}, async *run() {} } as BrainService);
    } });
    const live = definePlugin({ manifest: { id: "runtime-live", version: "0", licence: "MIT", provides: ["live"] }, apply(c) {
      c.offer("live", { items: () => [{ id: "x", label: "Live" }], start(f) {
        f.provide("live", { name: "test", capabilities: { tools: kind === "delegation" ? "delegation" : "function" }, async open() { throw new Error("unused"); } });
      } });
    } });
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, brain, live, conversation] });
    try {
      await k.applyConfig({ slots: { "conversation.live": kind === "cascade" ? "@none" : "l/x" }, plugins: [
        { id: "body", plugin: "body-hub" }, { id: "brain", plugin: "runtime-brain" }, { id: "l", plugin: "runtime-live" }, { id: "conv", plugin: "conversation" },
      ] });
      expect(k.status().find((x) => x.id === "brain")?.state).toBe(kind === "function" ? "loaded" : "active");
    } finally { await k.stopAll(); }
  });
});
const fakeVoice = definePlugin({
  manifest: { id: "fake-voice", version: "0", licence: "MIT", provides: ["voice", "tts"] },
  apply(ctx) {
    // Voix locales offertes une par une : la voix choisie parle dans le flux (viaStream).
    ctx.offer("tts", {
      max: 1,
      items: () => [{ id: "homme", label: "Homme" }, { id: "femme", label: "Femme" }],
      start(f, id) { f.provide("tts", { name: `locale ${id}`, viaStream: true }); },
    });
    const svc: VoiceService = {
      name: "fausse voix",
      open: async (id) => {
        const listeners = new Set<(e: VoiceEvent) => void>();
        const st = { emit: (e: VoiceEvent) => { for (const fn of listeners) fn(e); }, spoken: [] as string[], cancelled: 0 };
        streams.set(id, st);
        const s: VoiceStream = {
          pushAudio: () => {},
          speak: (sid, text) => {
            st.spoken.push(text);
            setTimeout(() => {
              st.emit({ type: "audio_start", id: sid });
              st.emit({ type: "audio", id: sid, data: new Uint8Array(8) });
              st.emit({ type: "speak_done", id: sid, cancelled: false });
            }, 1);
          },
          cancel: () => { st.cancelled++; },
          setSpeaking: () => {},
          ptt: () => {},
          on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
          close: () => {},
        };
        return s;
      },
    };
    ctx.provide("voice", svc);
  },
});

describe("Live dans l'orchestrateur, sans cerveau", () => {
  it("active sur le mot local, exclut l'audio précédent et ferme en veille", async () => {
    let receive!: (event: LiveEvent) => void;
    const pushed: number[] = [];
    const close = vi.fn(async () => {});
    const append = vi.fn();
    const open = vi.fn(async (o: Parameters<LiveService["open"]>[0]) => {
      receive = o.on;
      return { pushAudio: (frame: Float32Array) => pushed.push(...frame), toolResult: () => {}, append, close };
    });
    const live = definePlugin({
      manifest: { id: "fake-live", version: "0", licence: "MIT", provides: ["live"] },
      apply(ctx) { ctx.offer("live", { items: () => [{ id: "x", label: "Live" }], start(f) { f.provide("live", { name: "fake", capabilities: { tools: "function" }, open }); } }); },
    });
    streams.clear();
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, conversation, fakeVoice, live, wakewordStt] });
    try {
      await k.applyConfig({ slots: { "listen.wakeword": "stt/account", "conversation.live": "l/x" }, plugins: [
        { id: "stt", plugin: "wakeword-stt" },
        { id: "body", plugin: "body-hub" }, { id: "voice", plugin: "fake-voice" }, { id: "l", plugin: "fake-live" }, { id: "conv", plugin: "conversation" },
      ] });
      const avatar = new FakeBody("avatar", ["voice", "display", "emotion", "approval"]);
      k.service<import("@floppy/core").BodyHub>("body")!.attach(avatar.transport, { id: "avatar" }); avatar.hello();
      await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve)); // fin de l'initialisation du flux local
      avatar.feed(new Float32Array([1, 2, 3, 4]));
      const st = streams.get("avatar")!;
      // En Live, aucune voix locale ne tourne : le noyau n'a démarré aucun fork « tts ».
      expect(k.status().some((x) => x.fork?.service === "tts")).toBe(false);
      k.bus.emit("initiative", { source: "test", text: "Un travail est terminé.", importance: "important" });
      expect(append).not.toHaveBeenCalled();
      st.emit({ type: "transcript", text: "du bruit", start_sample: 0, end_sample: 2, audio_s: 1, stt_ms: 0, merged: false });
      expect(open).not.toHaveBeenCalled();
      st.emit({ type: "transcript", text: "Floppy bonjour", start_sample: 2, end_sample: 4, audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(pushed).toEqual([3, 4]));
      receive({ type: "audio", rate: 24000, pcm: new Int16Array([1]), generation: 0 });
      expect(avatar.audio).toBe(1);
      avatar.send({ type: "playback", playing: false });
      expect(append).toHaveBeenCalledWith("say", "Un travail est terminé.");
      avatar.send({ type: "mute", on: true });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(avatar.of("state").at(-1)?.state).toBe("sleep");
      receive({ type: "audio", rate: 24000, pcm: new Int16Array([2]), generation: 0 });
      expect(avatar.audio).toBe(1);
      avatar.feed(new Float32Array([5, 6]));
      st.emit({ type: "transcript", text: "sans mot", start_sample: 4, end_sample: 6, audio_s: 1, stt_ms: 0, merged: false });
      expect(open).toHaveBeenCalledOnce();
    } finally { await k.stopAll(); }
  });
  it("un Live indisponible ne répond pas aux phrases sans activation", async () => {
    streams.clear();
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, conversation, fakeVoice, wakewordStt] });
    try {
      await k.applyConfig({ slots: { "listen.wakeword": "stt/account", "conversation.live": "missing/x" }, plugins: [{ id: "stt", plugin: "wakeword-stt" }, { id: "body", plugin: "body-hub" }, { id: "voice", plugin: "fake-voice" }, { id: "conv", plugin: "conversation" }] });
      const avatar = new FakeBody("avatar", ["voice", "display"]);
      k.service<import("@floppy/core").BodyHub>("body")!.attach(avatar.transport, { id: "avatar" }); avatar.hello();
      await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
      await new Promise<void>((r) => setImmediate(r));
      const st = streams.get("avatar")!;
      st.emit({ type: "transcript", text: "une conversation ambiante", audio_s: 1, stt_ms: 0, merged: false });
      expect(avatar.of("error")).toHaveLength(0);
      st.emit({ type: "transcript", text: "Floppy bonjour", audio_s: 1, stt_ms: 0, merged: false });
      expect(avatar.of("error")).toHaveLength(1);
    } finally { await k.stopAll(); }
  });
});

// ------------------------------------------------------------------ faux cerveau : écho, ou appel d'outil
const fakeBrain = definePlugin({
  manifest: { id: "fake-brain", version: "0", licence: "MIT", provides: ["brain"] },
  apply(ctx) {
    const b: BrainService = {
      name: "faux",
      reset: () => {},
      async *run(input) {
        if (/raconte/.test(input.text)) {
          yield { type: "emotion", emotion: "happy" };
          yield { type: "text", delta: "Première phrase. Deu" };
          yield { type: "emotion", emotion: "mischief", intensity: 1.25 };
          yield { type: "text", delta: "xième phrase." };
        } else if (/ouvre|open/.test(input.text)) {
          const r = await ctx.tools.call("ouvrir_url", { url: "https://example.org" }, { origin: input.origin ?? "" });
          yield { type: "tool.result", name: "ouvrir_url", status: r.status };
          yield { type: "text", delta: r.status === "done" ? "C'est ouvert." : "D'accord, je ne l'ouvre pas." };
        } else {
          yield { type: "emotion", emotion: "happy" };
          yield { type: "text", delta: "Bonjour, je vais bien. " };
          yield { type: "text", delta: "Et toi ?" };
        }
        yield { type: "done", text: "" };
      },
    };
    ctx.provide("brain", b);
  },
});

const urlTool: BodyToolDecl = { name: "ouvrir_url", description: "Ouvre une URL", inputSchema: { type: "object", properties: { url: { type: "string" } } }, level: "write" };

describe("textes", () => {
  it("mot d'activation, oui/non, découpe en phrases", () => {
    expect(hasWakeWord("Floppy, quelle heure ?", ["floppy"])).toBe(true);
    expect(hasWakeWord("il fait beau", ["floppy"])).toBe(false);
    expect(stripWakeWord("Hey Floppy, quelle heure ?", ["floppy"])).toBe("quelle heure ?");
    expect(yesNo("Oui vas-y", ["floppy"])).toBe(true);
    expect(yesNo("Floppy non", ["floppy"])).toBe(false);
    expect(yesNo("ouvre le site des turn detectors stp", ["floppy"])).toBeUndefined();
    const s = new SentenceSplitter();
    expect(s.push("Bonjour, je suis là pour t'aider. Et ")).toEqual(["Bonjour, je suis là pour t'aider."]);
    // « Et toi ? » (2 mots) attend la suite : la voix ne lit pas de tout petits bouts.
    expect(s.push("toi ? Ok")).toEqual([]);
    expect(s.flush()).toEqual(["Et toi ? Ok"]);
    const t = new SentenceSplitter();
    expect(t.push("Oui. ")).toEqual(["Oui."]); // la 1re phrase part seule, même courte
    expect(t.push("Bien sûr. Voici la météo de demain. Il ")).toEqual(["Bien sûr. Voici la météo de demain."]);
    expect(t.push("pleut. Prends un parapluie, surtout le matin. ")).toEqual(["Il pleut. Prends un parapluie, surtout le matin."]);
  });

  it("un nouveau paragraphe est marqué, même si le retour à la ligne arrive en deux morceaux", () => {
    const s = new SentenceSplitter();
    expect(s.pushParts("Et alors, tu es convaincu ? J'ai tenu trois phrases.\n")).toEqual([
      { text: "Et alors, tu es convaincu ?", paragraph: false },
      { text: "J'ai tenu trois phrases.", paragraph: false },
    ]);
    expect(s.pushParts("\nBon, puisque le test est concluant. On ")).toEqual([{ text: "Bon, puisque le test est concluant.", paragraph: true }]);
    expect(s.pushParts("continue à s'amuser ?")).toEqual([]);
    expect(s.flushParts()).toEqual([{ text: "On continue à s'amuser ?", paragraph: false }]);
    const t = new SentenceSplitter();
    t.pushParts("Voici la réponse complète. ");
    expect(t.flushParts()).toEqual([]);
    expect(new SentenceSplitter().pushParts("Première phrase assez longue.\n\nDeuxième phrase assez longue. ").map((p) => p.paragraph)).toEqual([false, true]);
  });
});

describe("conversation (2 corps)", () => {
  let k: Kernel;
  let avatar: FakeBody;
  let chat: FakeBody;

  beforeEach(async () => {
    streams.clear();
    k = new Kernel({ home: mkdtempSync(join(tmpdir(), "conv-")), logger: () => {}, plugins: [bodyHub, conversation, fakeBrain, fakeVoice, wakewordStt] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] },
      slots: { "listen.wakeword": "stt/account" },
      approvals: { timeout_s: 5 },
      plugins: [
        { id: "stt", plugin: "wakeword-stt" },
        { id: "body", plugin: "body-hub" },
        { id: "voice", plugin: "fake-voice" },
        { id: "brain", plugin: "fake-brain" },
        { id: "conv", plugin: "conversation", config: { free_listen_s: 2, neutral_after_ms: 50 } },
      ],
    });
    const hub = k.service<{ attach(t: BodyTransport, o?: { id?: string; name?: string; managed?: boolean }): void }>("body")!;
    avatar = new FakeBody("avatar", ["voice", "display", "emotion", "approval"], [urlTool]);
    chat = new FakeBody("test", ["text", "approval"]);
    hub.attach(avatar.transport, { id: "avatar" }); avatar.hello();
    hub.attach(chat.transport, { id: "test" }); chat.hello();
    await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
  });
  afterEach(() => k.stopAll());

  it("après une coupure de parole, la phrase suivante est écoutée même si l'écoute libre était finie", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, bonjour", audio_s: 1, stt_ms: 0, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBe(2));
    // La réponse dure plus longtemps que l'écoute libre (2 s ici) : on avance l'horloge de 10 s.
    const real = Date.now;
    const shift = 10_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
    try {
      st.emit({ type: "barge_in" });
      st.emit({ type: "transcript", text: "Et le canal Contoso ?", audio_s: 1, stt_ms: 0, merged: false });
      expect(k.audit.tail(50).some((r) => r.kind === "turn.interrupted")).toBe(true);
      await vi.waitFor(() => expect(k.audit.tail(50).some((r) => r.kind === "transcript" && r.text === "Et le canal Contoso ?")).toBe(true));
      expect(k.audit.tail(50).some((r) => r.kind === "transcript.ignored")).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("trace une phrase jetée faute de mot d'activation, sans son texte", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "on parle d'autre chose", audio_s: 1, stt_ms: 0, merged: false });
    const rec = k.audit.tail(50).find((r) => r.kind === "transcript.ignored");
    expect(rec).toMatchObject({ why: "pas de mot d'activation", chars: 22 });
    expect(JSON.stringify(rec)).not.toContain("autre chose");
  });

  it("rejette les blocs audio d'un ancien tour, même pendant une nouvelle réponse", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, bonjour", audio_s: 1, stt_ms: 0, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBe(2));
    st.emit({ type: "barge_in" });
    const cut = avatar.audio;
    st.emit({ type: "audio", id: "t1-1", data: new Uint8Array(8) });
    expect(avatar.audio).toBe(cut);
    st.emit({ type: "transcript", text: "Floppy, recommence", audio_s: 1, stt_ms: 0, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBe(cut + 2));
    st.emit({ type: "audio", id: "t1-2", data: new Uint8Array(8) });
    expect(avatar.audio).toBe(cut + 2);
  });

  it("une émotion au milieu de la réponse attend que sa phrase soit dite", async () => {
    const st = streams.get("avatar")!;
    avatar.send({ type: "ptt", on: true }); // bouton parler : pas besoin du mot d'activation
    st.emit({ type: "transcript", text: "Floppy, raconte", audio_s: 1, stt_ms: 0, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBe(2));
    const i = avatar.got.findIndex((m) => m.type === "emotion" && m.emotion === "mischief");
    expect(avatar.got[i]).toMatchObject({ emotion: "mischief", intensity: 1.25 });
    expect(avatar.audioAt[i]).toBe(1); // après la voix de la 1re phrase, avant celle de la 2e
    expect(avatar.audioAt[avatar.got.findIndex((m) => m.type === "emotion" && m.emotion === "happy")]).toBe(0);
  });

  it("réagit tout de suite à « merci », donne l'humeur aux corps et hoche la tête quand on lui parle", async () => {
    expect(avatar.of("mood")).toHaveLength(1);
    chat.send({ type: "text", text: "merci beaucoup" });
    await vi.waitFor(() => expect(chat.of("reply.done")).toHaveLength(1));
    expect(avatar.of("emotion").find((e) => e.ms === 1200)).toMatchObject({ emotion: "happy" });
    expect(avatar.of("emotion").map((e) => e.emotion)).not.toContain("thinking");
    avatar.send({ type: "ptt", on: true });
    expect(avatar.of("cue").map((c) => c.cue)).toContain("perk");
    const st = streams.get("avatar")!;
    st.emit({ type: "vad", state: "speech" });
    await new Promise((r) => setTimeout(r, 520));
    st.emit({ type: "vad", state: "silence" });
    expect(avatar.of("cue").map((c) => c.cue)).toContain("nod");
    expect(chat.of("cue")).toHaveLength(0); // seulement les corps qui montrent des émotions
  });

  it("le ton est un réglage de conversation, indépendant du cerveau", () => {
    expect(k.settings.list().find((s) => s.key === "ton")).toMatchObject({ section: "voix", source: "conv" });
  });

  it("question tapée dans le corps texte : réponse en texte là-bas, rien n'est dit par l'avatar", async () => {
    chat.send({ type: "text", text: "ça va ?" });
    await vi.waitFor(() => expect(chat.of("reply.done")).toHaveLength(1));
    expect(chat.of("reply.done")[0]!.text).toBe("Bonjour, je vais bien. Et toi ?");
    expect(streams.get("avatar")!.spoken).toEqual([]);
    expect(avatar.of("reply.delta")).toHaveLength(0);
    // L'état et l'émotion arrivent sur l'avatar (il sait les montrer).
    expect(avatar.of("state").map((s) => s.state)).toContain("thinking");
    expect(avatar.of("emotion").map((e) => e.emotion)).toContain("happy");
  });

  it("phrase sans « Floppy » ignorée ; avec « Floppy » : réponse vocale sur l'avatar, phrase par phrase", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "il fait beau aujourd'hui", audio_s: 1, stt_ms: 50, merged: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(avatar.of("transcript")).toHaveLength(0);
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(st.spoken).toEqual(["Bonjour, je vais bien.", "Et toi ?"]));
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    expect(avatar.of("state").map((s) => s.state)).toContain("speaking");
    expect(chat.of("reply.done")).toHaveLength(0);
    // Fin de la lecture chez le corps → écoute libre : une phrase sans « Floppy » est acceptée.
    avatar.send({ type: "playback", playing: false });
    await vi.waitFor(() => expect(avatar.of("state").at(-1)?.state).toBe("listening"));
    st.emit({ type: "transcript", text: "et demain ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.of("transcript")).toHaveLength(2));
  });

  it("une détection STT pendant l'écoute libre n'autorise pas une phrase ultérieure après expiration", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const st = streams.get("avatar")!;
      st.emit({ type: "transcript", text: "Floppy bonjour", audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
      avatar.send({ type: "playback", playing: false });
      await vi.waitFor(() => expect(avatar.of("state").at(-1)?.state).toBe("listening"));
      clock.mockReturnValue(11_000);
      st.emit({ type: "transcript", text: "Floppy encore une question", audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(avatar.of("reply.done")).toHaveLength(2));
      clock.mockReturnValue(14_000);
      st.emit({ type: "transcript", text: "une conversation ambiante", audio_s: 1, stt_ms: 0, merged: false });
      await new Promise(r => setTimeout(r, 20));
      expect(avatar.of("transcript")).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  it("accord : demandé aux 2 corps, « oui » dit à l'avatar l'accorde, l'autre carte se ferme", async () => {
    const st = streams.get("avatar")!;
    avatar.onToolCall = (m) => avatar.send({ type: "tool.result", callId: m.callId, ok: true, text: "Ouvert." });
    st.emit({ type: "transcript", text: "Floppy, ouvre le site", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(chat.of("approval.request")).toHaveLength(1));
    expect(avatar.of("approval.request")).toHaveLength(1);
    await vi.waitFor(() => expect(st.spoken).toContain("J'ai besoin de ton accord."));
    st.emit({ type: "transcript", text: "oui", audio_s: 0.4, stt_ms: 30, merged: false });
    await vi.waitFor(() => expect(st.spoken).toContain("C'est ouvert."));
    expect(chat.of("approval.closed")[0]).toMatchObject({ ok: true });
    expect(k.audit.tail(50).find((r) => r.kind === "approval")).toMatchObject({ ok: true, by: "avatar:voix" });
  });

  it("un « oui » dit sur un autre corps, ou pendant la veille, ne répond pas à l'accord d'un autre", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, ouvre le site", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(chat.of("approval.request")).toHaveLength(1));
    expect(k.approvals.pending()[0]!.origin).toBe("avatar");
    // le corps texte (capable d'accord, mais pas d'origine) dit « oui » : sans effet
    chat.send({ type: "text", text: "oui" });
    await new Promise((r) => setTimeout(r, 30));
    expect(k.approvals.pending()).toHaveLength(1);
    // l'avatar en veille : « oui » entendu sans mot d'activation ne répond pas non plus
    avatar.send({ type: "mute", on: true });
    st.emit({ type: "transcript", text: "oui", audio_s: 0.4, stt_ms: 30, merged: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(k.approvals.pending()).toHaveLength(1);
    expect(k.audit.tail(100).some((r) => r.kind === "approval")).toBe(false);
  });

  it("audit : seules les phrases retenues sont tracées (ni ignorées sans mot d'activation, ni dites en veille)", async () => {
    const st = streams.get("avatar")!;
    const texts = () => k.audit.tail(100).filter((r) => r.kind === "transcript").map((r) => (r as { text?: string }).text);
    st.emit({ type: "transcript", text: "il fait beau aujourd'hui", audio_s: 1, stt_ms: 50, merged: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(texts()).toEqual([]);
    avatar.send({ type: "mute", on: true });
    st.emit({ type: "transcript", text: "mot de passe secret", audio_s: 1, stt_ms: 50, merged: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(texts()).toEqual([]);
    avatar.send({ type: "mute", on: false });
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(texts()).toEqual(["Floppy, ça va ?"]));
  });

  it("accord refusé par clic sur le corps texte : l'outil n'est pas appelé", async () => {
    const st = streams.get("avatar")!;
    let called = false;
    avatar.onToolCall = () => { called = true; };
    st.emit({ type: "transcript", text: "Floppy, ouvre le site", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(chat.of("approval.request")).toHaveLength(1));
    chat.send({ type: "approval.response", id: chat.of("approval.request")[0]!.id, ok: false });
    await vi.waitFor(() => expect(st.spoken).toContain("D'accord, je ne l'ouvre pas."));
    expect(called).toBe(false);
  });

  it("débrancher un corps retire ses outils corps, sans casser les autres", async () => {
    expect(k.tools.list().map((t) => t.name)).toContain("ouvrir_url");
    avatar.leave();
    expect(k.tools.list().map((t) => t.name)).not.toContain("ouvrir_url");
    chat.send({ type: "text", text: "ça va ?" });
    await vi.waitFor(() => expect(chat.of("reply.done")).toHaveLength(1));
  });

  it("« Floppy, dors » : veille ; une phrase sans le mot est ignorée ; « Floppy » réveille", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, dors", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.of("state").at(-1)?.state).toBe("sleep"));
    st.emit({ type: "transcript", text: "ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(avatar.of("transcript")).toHaveLength(0);
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(st.spoken.length).toBeGreaterThan(0));
  });

  it("initiative importante : dite sur la voix, affichée en notification sur les corps écran et texte", async () => {
    const st = streams.get("avatar")!;
    k.bus.emit("initiative", { source: "orca", text: "Le job build est terminé.", importance: "important", key: "j1" });
    await vi.waitFor(() => expect(st.spoken).toEqual(["Le job build est terminé."]));
    expect(avatar.of("notify")[0]).toMatchObject({ text: "Le job build est terminé.", important: true });
    expect(chat.of("notify")).toHaveLength(1);
    expect(k.audit.tail(50).find((r) => r.kind === "initiative")).toMatchObject({ source: "orca", spoken: true });
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    avatar.send({ type: "playback", playing: false });
    await vi.waitFor(() => expect(avatar.of("state").at(-1)?.state).toBe("listening"));
  });

  it("initiative pendant un tour : mise en file, dite après", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    k.bus.emit("initiative", { source: "orca", text: "Revue terminée.", importance: "important" });
    expect(st.spoken).not.toContain("Revue terminée.");
    avatar.send({ type: "playback", playing: false });
    await vi.waitFor(() => expect(st.spoken).toContain("Revue terminée."));
  });

  it("initiative importante pendant la veille : pas dite, mais notifiée", async () => {
    const st = streams.get("avatar")!;
    avatar.send({ type: "mute", on: true });
    k.bus.emit("initiative", { source: "orca", text: "Alerte.", importance: "important" });
    await new Promise((r) => setTimeout(r, 30));
    expect(st.spoken).toEqual([]);
    expect(avatar.of("notify")).toHaveLength(1);
    avatar.send({ type: "mute", on: false });
    await vi.waitFor(() => expect(st.spoken).toEqual(["Alerte."]));
  });

  it("réglage mot_activation : « jarvis » accepté, « floppy » ignoré", async () => {
    const st = streams.get("avatar")!;
    const r = await k.items.run({ op: "update", provider: "stt-account", id: "account", values: { words: ["jarvis"] } }, "ui");
    expect(r.ok).toBe(true);
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(avatar.of("transcript")).toHaveLength(0);
    st.emit({ type: "transcript", text: "Jarvis, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.of("transcript")).toHaveLength(1));
    expect((await k.items.run({ op: "update", provider: "stt-account", id: "account", values: { words: ["a", "b"] } }, "ui")).ok).toBe(false);
  });

  it("interruption : l'utilisateur parle pendant la voix → tout s'arrête", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    // Voix entendue : on baisse le son sans couper, en attendant de savoir qui parle.
    st.emit({ type: "barge_in" });
    expect(avatar.of("duck")).toEqual([{ type: "duck", on: true }]);
    expect(avatar.of("interrupt")).toHaveLength(0);
    // Le texte reconnu n'est pas ce que dit Floppy : c'est l'utilisateur, tout s'arrête.
    st.emit({ type: "transcript", text: "Attends, change de sujet", audio_s: 1, stt_ms: 50, merged: false });
    expect(avatar.of("interrupt")).toHaveLength(1);
    expect(st.cancelled).toBe(1);
  });

  it("écho : la voix de Floppy reprise par le micro ne coupe pas la réponse", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    st.emit({ type: "barge_in" });
    // Le micro a entendu Floppy lui-même (le STT déforme un peu).
    st.emit({ type: "transcript", text: "bonjour je vais bien", audio_s: 1, stt_ms: 50, merged: false });
    expect(avatar.of("duck")).toEqual([{ type: "duck", on: true }, { type: "duck", on: false }]);
    expect(avatar.of("interrupt")).toHaveLength(0);
    expect(st.cancelled).toBe(0);
    expect(k.audit.tail(50).find((r) => r.kind === "transcript.echo")).toMatchObject({ ducked: true });
    expect(k.audit.tail(50).some((r) => r.kind === "transcript" && r.text === "bonjour je vais bien")).toBe(false);
  });

  it("un mot seul (« stop ») coupe toujours, même s'il ressemble à ce que dit Floppy", async () => {
    const st = streams.get("avatar")!;
    st.emit({ type: "transcript", text: "Floppy, ça va ?", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    st.emit({ type: "barge_in" });
    st.emit({ type: "transcript", text: "Bien.", audio_s: 1, stt_ms: 50, merged: false });
    expect(avatar.of("interrupt")).toHaveLength(1);
  });
});

describe("conversation : accord à la voix pendant la phrase d'accord", () => {
  it("l'utilisateur dit « oui » (interruption détectée) : le tour continue et la réponse finale est dite", async () => {
    streams.clear();
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, conversation, fakeBrain, fakeVoice, wakewordStt] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      slots: { "listen.wakeword": "stt/account" },
      plugins: [
        { id: "stt", plugin: "wakeword-stt" },
        { id: "body", plugin: "body-hub" }, { id: "voice", plugin: "fake-voice" },
        { id: "brain", plugin: "fake-brain" }, { id: "conv", plugin: "conversation" },
      ],
    });
    const hub = k.service<{ attach(t: BodyTransport, o?: { id?: string; name?: string; managed?: boolean }): void }>("body")!;
    const avatar = new FakeBody("avatar", ["voice", "emotion", "approval"], [urlTool]);
    avatar.onToolCall = (m) => avatar.send({ type: "tool.result", callId: m.callId, ok: true, text: "Ouvert." });
    hub.attach(avatar.transport, { id: "avatar" }); avatar.hello();
    await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
    const st = streams.get("avatar")!;
    await new Promise<void>(r => setImmediate(r));
    st.emit({ type: "transcript", text: "Floppy, ouvre le site", audio_s: 1, stt_ms: 50, merged: false });
    await vi.waitFor(() => expect(st.spoken).toContain("J'ai besoin de ton accord."));
    await vi.waitFor(() => expect(avatar.audio).toBeGreaterThan(0));
    st.emit({ type: "barge_in" });            // l'utilisateur commence à parler
    st.emit({ type: "transcript", text: "Oui, vas-y.", audio_s: 1, stt_ms: 30, merged: false });
    await vi.waitFor(() => expect(st.spoken).toContain("C'est ouvert."));
    expect(k.audit.tail(50).some((r) => r.kind === "turn.interrupted")).toBe(false);
    await k.stopAll();
  });
});

describe("voie rapide des réglages (sans LLM)", () => {
  const settings = [
    { key: "brain", role: "brain.main", label: "Moteur", type: "enum", options: [
      { value: "gemma", label: "Gemma 4 12B", aliases: ["gemma"], slow: true },
      { value: "qwen9b", label: "Qwen3.5 9B", aliases: ["qwen 9b", "petit qwen"], slow: true },
      { value: "qwen35b", label: "Qwen3.6 35B-A3B", aliases: ["qwen", "gros qwen"], slow: true },
      { value: "claude", label: "Claude (cloud)", aliases: ["claude"] },
    ] },
    { key: "tts", label: "Voix", type: "enum", options: [
      { value: "homme", label: "voix d'homme", aliases: ["homme"] },
      { value: "femme", label: "voix de femme", aliases: ["femme"] },
    ] },
  ];
  it("reconnaît les demandes courtes de changement", () => {
    expect(matchQuickSetting("Floppy, reviens sur Gemma", ["floppy"], settings)).toMatchObject({ key: "brain", value: "gemma", slow: true });
    expect(matchQuickSetting("passe sur claude", ["floppy"], settings)).toMatchObject({ slow: false });
    expect(matchQuickSetting("bascule sur Qwen", ["floppy"], settings)).toMatchObject({ key: "brain", value: "qwen35b" });
    expect(matchQuickSetting("passe sur qwen 9b", ["floppy"], settings)).toMatchObject({ key: "brain", value: "qwen9b" });
    expect(matchQuickSetting("prends la voix de femme", ["floppy"], settings)).toMatchObject({ key: "tts", value: "femme" });
    expect(matchQuickSetting("passe le cerveau sur claude", ["floppy"], settings)).toMatchObject({ key: "brain", value: "claude" });
  });
  it("laisse le cerveau décider sinon", () => {
    expect(matchQuickSetting("change de voix", ["floppy"], settings)).toBeUndefined();          // pas de valeur
    expect(matchQuickSetting("est-ce que gemma est meilleur que qwen ?", ["floppy"], settings)).toBeUndefined(); // pas un ordre
    expect(matchQuickSetting("passe-moi le compte rendu de la réunion avec le client de gemma demain matin s'il te plaît", ["floppy"], settings)).toBeUndefined(); // trop long
  });
});

describe("anglais (langue de l'assistant « en »)", () => {
  it("reconnaît oui / non, la veille et le réveil en anglais (le français reste accepté)", () => {
    for (const yes of ["yes", "Yeah, go ahead", "sure", "Floppy, do it", "OK"]) expect(yesNo(yes, ["floppy"])).toBe(true);
    for (const no of ["no", "Nope", "cancel", "never mind", "don't", "of course not", "non"]) expect(yesNo(no, ["floppy"])).toBe(false);
    expect(yesNo("open the website please", ["floppy"])).toBeUndefined();
    expect(isSleepCommand("Floppy, go to sleep", ["floppy"])).toBe(true);
    expect(isSleepCommand("Floppy, sleep", ["floppy"])).toBe(true);
    expect(isSleepCommand("how did you sleep", ["floppy"])).toBe(false);
    expect(isSleepCommand("Floppy, dors", ["floppy"])).toBe(true);
    expect(isWakeUpPhrase("wake up")).toBe(true);
    expect(isWakeUpPhrase("réveille-toi")).toBe(true);
    expect(stripWakeWord("Hi Floppy, what time is it?", ["floppy"])).toBe("what time is it?");
  });

  it("voie rapide en anglais : libellé rendu dans la langue demandée", () => {
    const settings = [{ key: "tts", label: { fr: "Voix", en: "Voice" }, type: "enum", options: [
      { value: "homme", label: { fr: "voix d'homme", en: "male voice" } },
      { value: "femme", label: { fr: "voix de femme", en: "female voice" } },
    ] }, { key: "brain", role: "brain.main", label: "Moteur", type: "enum", options: [{ value: "gemma", label: "Gemma 4 12B", aliases: ["gemma"], slow: true }] }];
    expect(matchQuickSetting("Floppy, switch to the female voice", ["floppy"], settings, "en")).toMatchObject({ key: "tts", value: "femme", label: "female voice" });
    expect(matchQuickSetting("use Gemma", ["floppy"], settings, "en")).toMatchObject({ key: "brain", value: "gemma" });
    expect(matchQuickSetting("prends la voix de femme", ["floppy"], settings)).toMatchObject({ label: "voix de femme" });
  });

  it("consignes Live en anglais ; le français reste identique", () => {
    const en = liveInstructions({ name: "Floppy", language: "en", tone: "friendly", recent: [] });
    expect(en).toMatch(/^You are Floppy\. Language: English\. Tone: friendly\./);
    expect(en).not.toMatch(/Tu es|Réponds/);
    const fr = liveInstructions({ name: "Floppy", language: "fr", tone: "sobre", recent: [] });
    expect(fr.split("\n")[0]).toBe("Tu es Floppy. Langue : fr. Ton : sobre. Réponds brièvement à l'oral.");
  });

  it("devine l'émotion de mots anglais", () => {
    expect(guessEmotion("thank you!", "user")?.emotion).toBe("happy");
    expect(guessEmotion("well done Floppy", "user")?.emotion).toBe("proud");
    expect(guessEmotion("Sorry, I can't do that.", "reply")?.emotion).toBe("sorry");
  });

  describe("de bout en bout", () => {
    let k: Kernel;
    let avatar: FakeBody;
    beforeEach(async () => {
      streams.clear();
      k = new Kernel({ logger: () => {}, plugins: [bodyHub, conversation, fakeBrain, fakeVoice, wakewordStt] });
      await k.applyConfig({
        assistant: { name: "Floppy", language: "en", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
        slots: { "listen.wakeword": "stt/account" },
        plugins: [
          { id: "stt", plugin: "wakeword-stt" },
          { id: "body", plugin: "body-hub" }, { id: "voice", plugin: "fake-voice" },
          { id: "brain", plugin: "fake-brain" }, { id: "conv", plugin: "conversation" },
        ],
      });
      const hub = k.service<{ attach(t: BodyTransport, o?: { id?: string; name?: string; managed?: boolean }): void }>("body")!;
      avatar = new FakeBody("avatar", ["voice", "emotion", "approval"], [urlTool]);
      avatar.onToolCall = (m) => avatar.send({ type: "tool.result", callId: m.callId, ok: true, text: "Opened." });
      hub.attach(avatar.transport, { id: "avatar" }); avatar.hello();
      await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
      await new Promise<void>(r => setImmediate(r));
    });
    afterEach(() => k.stopAll());

    it("dit la demande d'accord en anglais ; « yes, go ahead » l'accorde", async () => {
      const st = streams.get("avatar")!;
      st.emit({ type: "transcript", text: "Floppy, open the website", audio_s: 1, stt_ms: 50, merged: false });
      await vi.waitFor(() => expect(st.spoken).toContain("I need your approval."));
      st.emit({ type: "transcript", text: "Yes, go ahead.", audio_s: 1, stt_ms: 30, merged: false });
      await vi.waitFor(() => expect(st.spoken).toContain("C'est ouvert."));
      expect(k.audit.tail(50).find((r) => r.kind === "approval")).toMatchObject({ ok: true });
    });

    it("« never mind » refuse l'accord ; « go to sleep » met en veille", async () => {
      const st = streams.get("avatar")!;
      st.emit({ type: "transcript", text: "Floppy, open the website", audio_s: 1, stt_ms: 50, merged: false });
      await vi.waitFor(() => expect(st.spoken).toContain("I need your approval."));
      st.emit({ type: "transcript", text: "never mind", audio_s: 1, stt_ms: 30, merged: false });
      await vi.waitFor(() => expect(st.spoken).toContain("D'accord, je ne l'ouvre pas."));
      avatar.send({ type: "playback", playing: false });
      st.emit({ type: "transcript", text: "Floppy, go to sleep", audio_s: 1, stt_ms: 30, merged: false });
      await vi.waitFor(() => expect(avatar.of("state").at(-1)?.state).toBe("sleep"));
    });
  });
});
