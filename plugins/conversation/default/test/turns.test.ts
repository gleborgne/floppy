// Tours : verrou par corps, longue pause, « répète », cause des erreurs. Faux cerveau pilotable, corps en mémoire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Kernel, definePlugin } from "@floppy/core";
import type { BodyHub, BrainEvent, BrainRunInput, BrainService, VoiceEvent, VoiceService, VoiceStream } from "@floppy/contracts";
import type { BodyToKernel, BodyTransport, Capability, KernelToBody } from "@floppy/protocol";
import bodyHub from "@floppy/plugin-body-hub";
import conversation from "../src/index.ts";

class FakeBody {
  got: KernelToBody[] = [];
  private onMsg?: (m: BodyToKernel) => void;
  transport: BodyTransport = {
    send: (m) => { this.got.push(m); },
    sendAudio: () => {},
    onMessage: (fn) => { this.onMsg = fn; },
    onAudio: () => {},
    onClose: () => {},
    close: () => {},
  };
  id: string;
  caps: Capability[];
  constructor(id: string, caps: Capability[]) { this.id = id; this.caps = caps; }
  hello() { this.onMsg!({ type: "hello", id: this.id, name: this.id, version: "0", capabilities: this.caps, tools: [] }); }
  say(text: string) { this.onMsg!({ type: "text", text }); }
  send(m: BodyToKernel) { this.onMsg!(m); }
  of<T extends KernelToBody["type"]>(t: T) { return this.got.filter((m) => m.type === t) as Extract<KernelToBody, { type: T }>[]; }
}

const streams = new Map<string, { emit: (e: VoiceEvent) => void; spoken: string[] }>();
const fakeVoice = definePlugin({
  manifest: { id: "turns-voice", version: "0", licence: "MIT", provides: ["voice", "tts"] },
  apply(ctx) {
    ctx.offer("tts", { max: 1, items: () => [{ id: "v", label: "Voix" }], start(f) { f.provide("tts", { name: "locale", viaStream: true }); } });
    const svc: VoiceService = {
      name: "fausse voix",
      open: async (id) => {
        const listeners = new Set<(e: VoiceEvent) => void>();
        const st = { emit: (e: VoiceEvent) => { for (const fn of listeners) fn(e); }, spoken: [] as string[] };
        streams.set(id, st);
        const s: VoiceStream = {
          pushAudio: () => {},
          speak: (sid, text) => {
            st.spoken.push(text);
            setTimeout(() => { st.emit({ type: "audio_start", id: sid }); st.emit({ type: "audio", id: sid, data: new Uint8Array(8) }); st.emit({ type: "speak_done", id: sid, cancelled: false }); }, 1);
          },
          cancel: () => {}, setSpeaking: () => {}, ptt: () => {},
          on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
          close: () => {},
        };
        return s;
      },
    };
    ctx.provide("voice", svc);
  },
});

interface Setup { run: (input: BrainRunInput) => AsyncGenerator<BrainEvent>; rest?: (session: string) => void; reset?: (session: string) => void }
async function fixture(setup: Setup, config: Record<string, unknown> = {}, voice = false) {
  const brain = definePlugin({ manifest: { id: "turns-brain", version: "0", licence: "MIT", provides: ["brain"] }, apply(ctx) {
    const svc: BrainService = { name: "pilotable", reset: setup.reset ?? (() => {}), ...(setup.rest ? { rest: setup.rest } : {}), run: setup.run };
    ctx.provide("brain", svc);
  } });
  const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "turns-")), logger: () => {}, plugins: [bodyHub, conversation, brain, fakeVoice] });
  await k.applyConfig({ assistant: { name: "Floppy", wake_words: ["floppy"] }, plugins: [
    { id: "body", plugin: "body-hub" }, ...(voice ? [{ id: "voice", plugin: "turns-voice" }] : []), { id: "brain", plugin: "turns-brain" }, { id: "conv", plugin: "conversation", config }] });
  const attach = async (id: string, caps: Capability[]) => {
    const body = new FakeBody(id, caps);
    k.service<BodyHub>("body")!.attach(body.transport, { id }); body.hello();
    if (caps.includes("voice")) { await vi.waitFor(() => expect(streams.has(id)).toBe(true)); await new Promise<void>((r) => setImmediate(r)); }
    return body;
  };
  return { k, attach };
}

describe("verrou par corps", () => {
  it("un corps lent ne fait pas attendre un autre corps ; un même corps garde un seul tour à la fois", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const started: string[] = [];
    const f = await fixture({ async *run(input) {
      started.push(input.text);
      if (input.text === "lent") await gate;
      yield { type: "text", delta: `réponse à ${input.text}` };
    } });
    try {
      const slow = await f.attach("slow", ["text"]);
      const fast = await f.attach("fast", ["text"]);
      slow.say("lent");
      await vi.waitFor(() => expect(started).toEqual(["lent"]));
      fast.say("salut");
      await vi.waitFor(() => expect(fast.of("reply.done")).toHaveLength(1));
      expect(fast.of("reply.done")[0]!.text).toBe("réponse à salut");
      expect(slow.of("reply.done")).toHaveLength(0);
      // Même corps : la nouvelle demande attend la fin du tour précédent.
      slow.say("suite");
      await new Promise((r) => setTimeout(r, 30));
      expect(started).toEqual(["lent", "salut"]);
      open();
      await vi.waitFor(() => expect(slow.of("reply.done").map((m) => m.text)).toEqual(["réponse à suite"]));
      expect(started).toEqual(["lent", "salut", "suite"]);
    } finally { open(); await f.k.stopAll(); }
  });
});

describe("longue pause", () => {
  it("le cerveau qui sait se reposer garde un résumé : rest au lieu de reset", async () => {
    const rest = vi.fn(), reset = vi.fn();
    const f = await fixture({ rest, reset, async *run() { yield { type: "text", delta: "ok" }; } });
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("bonjour");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(rest).toHaveBeenCalledWith("chat");
      expect(reset).not.toHaveBeenCalled();
    } finally { await f.k.stopAll(); }
  });
  it("sans rest, la longue pause efface comme avant", async () => {
    const reset = vi.fn();
    const f = await fixture({ reset, async *run() { yield { type: "text", delta: "ok" }; } });
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("bonjour");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(reset).toHaveBeenCalledWith("chat");
    } finally { await f.k.stopAll(); }
  });
});

describe("« répète »", () => {
  const answers = ["Il fait beau. Et demain aussi.", "Autre réponse."];
  const brainTexts: string[] = [];
  const setup = (): Setup => ({ async *run(input) { brainTexts.push(input.text); yield { type: "text", delta: answers[(brainTexts.length - 1) % 2]! }; } });

  it("texte : redit la dernière réponse sans appeler le cerveau, et l'audite", async () => {
    brainTexts.length = 0;
    const f = await fixture(setup());
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("quel temps ?");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      body.say("répète");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(2));
      expect(body.of("reply.done")[1]!.text).toBe("Il fait beau. Et demain aussi.");
      expect(brainTexts).toEqual(["quel temps ?"]);
      expect(f.k.audit.tail(50).some((r) => r.kind === "reply.repeated" && r.body === "chat")).toBe(true);
      body.say("répète après moi : bonjour");
      await vi.waitFor(() => expect(brainTexts).toHaveLength(2));
    } finally { await f.k.stopAll(); }
  });
  it("sans dernière réponse, la phrase passe au cerveau", async () => {
    brainTexts.length = 0;
    const f = await fixture(setup());
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("repeat");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(brainTexts).toEqual(["repeat"]);
      expect(f.k.audit.tail(50).some((r) => r.kind === "reply.repeated")).toBe(false);
    } finally { await f.k.stopAll(); }
  });
  it("voix : la réponse est redite par sayDirect, sans cerveau", async () => {
    brainTexts.length = 0;
    streams.clear();
    const f = await fixture(setup(), { free_listen_s: 2 }, true);
    try {
      const body = await f.attach("avatar", ["voice", "display", "emotion"]);
      const st = streams.get("avatar")!;
      body.say("Floppy, quel temps ?"); // saisie sur le corps vocal : même tour que la voix
      await vi.waitFor(() => expect(st.spoken).toHaveLength(2)); // phrase par phrase
      await vi.waitFor(() => expect(body.of("state").at(-1)?.state).toBe("speaking"));
      body.send({ type: "playback", playing: false });
      await vi.waitFor(() => expect(body.of("state").at(-1)?.state).toBe("listening"));
      st.emit({ type: "transcript", text: "Floppy, say that again", audio_s: 1, stt_ms: 0, merged: false });
      await vi.waitFor(() => expect(st.spoken.filter((s) => s === "Il fait beau. Et demain aussi.")).toHaveLength(1)); // redite d'un bloc
      expect(brainTexts).toEqual(["Floppy, quel temps ?"]);
      expect(f.k.audit.tail(50).some((r) => r.kind === "reply.repeated")).toBe(true);
    } finally { await f.k.stopAll(); }
  });
});

describe("erreurs qui disent la cause", () => {
  const lastReply = (b: FakeBody) => b.of("reply.done").at(-1)!.text;
  it("réseau : phrase dédiée", async () => {
    const f = await fixture({ async *run() { throw new TypeError("fetch failed"); } });
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("salut");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(lastReply(body)).toMatch(/joindre le service/);
    } finally { await f.k.stopAll(); }
  });
  it("silence du cerveau : phrase dédiée", async () => {
    const f = await fixture({ async *run(input) { await new Promise((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("arrêté")))); yield { type: "text", delta: "" }; } }, { turn_idle_s: 0.05 });
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("salut");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(lastReply(body)).toMatch(/ne répond plus/);
    } finally { await f.k.stopAll(); }
  });
  it("autre erreur : phrase par défaut, ou error_reply de l'utilisateur", async () => {
    const run: Setup["run"] = async function* () { throw new Error("boum"); };
    const a = await fixture({ run });
    try {
      const body = await a.attach("chat", ["text"]);
      body.say("salut");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(lastReply(body)).toMatch(/n'arrive pas à réfléchir/);
    } finally { await a.k.stopAll(); }
    const b = await fixture({ run }, { error_reply: "Oups perso" });
    try {
      const body = await b.attach("chat", ["text"]);
      body.say("salut");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(lastReply(body)).toBe("Oups perso");
    } finally { await b.k.stopAll(); }
  });
  it("error_reply ne masque pas les causes précises", async () => {
    const f = await fixture({ async *run() { throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" }); } }, { error_reply: "Oups perso" });
    try {
      const body = await f.attach("chat", ["text"]);
      body.say("salut");
      await vi.waitFor(() => expect(body.of("reply.done")).toHaveLength(1));
      expect(lastReply(body)).toMatch(/joindre le service/);
    } finally { await f.k.stopAll(); }
  });
});
