// Choix dans une liste : reconnaissance de la réponse (fr / en) et outil ask_choice de bout en bout.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainService, VoiceEvent, VoiceService, BodyHub } from "@floppy/contracts";
import type { BodyToKernel, BodyTransport, KernelToBody, Capability } from "@floppy/protocol";
import bodyHub from "@floppy/plugin-body-hub";
import wakewordStt from "@floppy/plugin-wakeword-stt";
import conversation, { matchChoice, choicePrompt } from "../src/index.ts";

const wake = ["floppy"];
const fruits = [{ id: "a", label: "Pomme" }, { id: "b", label: "Poire rouge" }, { id: "c", label: "Cerise" }];
const files = [{ id: "r", label: "rapport.docx" }, { id: "n", label: "notes.txt" }];

describe("matchChoice", () => {
  it.each([["2", "b"], ["numéro 3", "c"], ["Floppy, 1", "a"], ["option 2 s'il te plaît", "b"]])("chiffre : %s", (text, id) => {
    expect(matchChoice(text, wake, fruits)).toBe(id);
  });
  it.each([["deux", "b"], ["trois", "c"], ["two", "b"], ["three please", "c"], ["un", "a"], ["one", "a"], ["option one", "a"]])("nombre en toutes lettres : %s", (text, id) => {
    expect(matchChoice(text, wake, fruits)).toBe(id);
  });
  it.each([["la deuxième", "b"], ["le premier", "a"], ["la troisième", "c"], ["la seconde", "b"], ["the second one", "b"], ["the third", "c"], ["first", "a"], ["je prends la première", "a"]])("ordinal : %s", (text, id) => {
    expect(matchChoice(text, wake, fruits)).toBe(id);
  });
  it.each([["la dernière", "c"], ["le dernier", "c"], ["the last one", "c"], ["last", "c"]])("dernier : %s", (text, id) => {
    expect(matchChoice(text, wake, fruits)).toBe(id);
  });
  it("libellé : en entier, ou un mot distinctif porté par une seule option", () => {
    expect(matchChoice("la cerise", wake, fruits)).toBe("c");
    expect(matchChoice("Poire rouge", wake, fruits)).toBe("b");
    expect(matchChoice("le rouge", wake, fruits)).toBe("b");
    expect(matchChoice("poire", wake, fruits)).toBe("b");
    expect(matchChoice("le fichier notes.txt s'il te plaît", wake, files)).toBe("n");
    expect(matchChoice("Floppy, la pomme", wake, fruits)).toBe("a");
  });
  it("libellé : sans accents, et le plus long libellé cité gagne", () => {
    expect(matchChoice("cerise", wake, [{ id: "x", label: "Cérise" }, { id: "y", label: "Pomme" }])).toBe("x");
    const nested = [{ id: "s", label: "Rouge" }, { id: "l", label: "Rouge vif" }];
    expect(matchChoice("rouge vif", wake, nested)).toBe("l");
    expect(matchChoice("rouge", wake, nested)).toBe("s");
  });
  it("le mot d'activation est retiré, même seul au milieu", () => {
    expect(matchChoice("Hey Floppy, la deuxième", wake, fruits)).toBe("b");
    expect(matchChoice("Floppy", wake, fruits)).toBeUndefined();
  });
  it("ambigu : plusieurs rangs, plusieurs options pour le même mot, hors liste", () => {
    expect(matchChoice("le premier ou le deuxième", wake, fruits)).toBeUndefined();
    expect(matchChoice("1 ou 3", wake, fruits)).toBeUndefined();
    expect(matchChoice("rouge", wake, [{ id: "a", label: "Pomme rouge" }, { id: "b", label: "Poire rouge" }])).toBeUndefined();
    expect(matchChoice("5", wake, fruits)).toBeUndefined();
    expect(matchChoice("0", wake, fruits)).toBeUndefined();
    expect(matchChoice("la quatrième", wake, fruits)).toBeUndefined();
  });
  it("sans rapport, vide ou trop long : rien (l'énoncé est traité normalement)", () => {
    expect(matchChoice("quelle heure est-il ?", wake, fruits)).toBeUndefined();
    expect(matchChoice("oui", wake, fruits)).toBeUndefined();
    expect(matchChoice("non merci", wake, fruits)).toBeUndefined();
    expect(matchChoice("", wake, fruits)).toBeUndefined();
    expect(matchChoice("2", wake, [])).toBeUndefined();
    expect(matchChoice("je pense que finalement je vais prendre la deuxième si tu veux bien", wake, fruits)).toBeUndefined();
  });
});

describe("choicePrompt", () => {
  it("dit la question et les options numérotées dans la langue de l'assistant", () => {
    expect(choicePrompt("Quel fruit ?", fruits, "fr")).toBe("Quel fruit ? un : Pomme, deux : Poire rouge, trois : Cerise.");
    expect(choicePrompt("Pick a fruit", fruits, "en")).toBe("Pick a fruit. one : Pomme, two : Poire rouge, three : Cerise.");
  });
});

// ------------------------------------------------------------------ plugin complet : faux cerveau, fausse voix, corps en mémoire
class FakeBody {
  got: KernelToBody[] = [];
  private onMsg?: (m: BodyToKernel) => void;
  transport: BodyTransport = {
    send: (m) => { this.got.push(m); },
    sendAudio: () => {}, onMessage: (fn) => { this.onMsg = fn; }, onAudio: () => {}, onClose: () => {}, close: () => {},
  };
  id: string;
  caps: Capability[];
  constructor(id: string, caps: Capability[]) { this.id = id; this.caps = caps; }
  hello() { this.onMsg!({ type: "hello", id: this.id, name: this.id, version: "0", capabilities: this.caps, tools: [] }); }
  send(m: BodyToKernel) { this.onMsg!(m); }
  of<T extends KernelToBody["type"]>(t: T) { return this.got.filter((m) => m.type === t) as Extract<KernelToBody, { type: T }>[]; }
}

const streams = new Map<string, { emit: (e: VoiceEvent) => void; spoken: string[] }>();
const fakeVoice = definePlugin({
  manifest: { id: "fake-voice", version: "0", licence: "MIT", provides: ["voice", "tts"] },
  apply(ctx) {
    // Une voix locale qui parle dans le flux (sinon la conversation signale « voix indisponible » et ne dit rien).
    ctx.offer("tts", { max: 1, items: () => [{ id: "homme", label: "Homme" }], start(f) { f.provide("tts", { name: "locale", viaStream: true }); } });
    const svc: VoiceService = {
      name: "fausse voix",
      open: async (id) => {
        const listeners = new Set<(e: VoiceEvent) => void>();
        const st = { emit: (e: VoiceEvent) => { for (const fn of listeners) fn(e); }, spoken: [] as string[] };
        streams.set(id, st);
        return {
          pushAudio: () => {}, cancel: () => {}, setSpeaking: () => {}, ptt: () => {}, close: () => {},
          speak: (sid: string, text: string) => {
            st.spoken.push(text);
            setTimeout(() => { st.emit({ type: "audio_start", id: sid }); st.emit({ type: "audio", id: sid, data: new Uint8Array(8) }); st.emit({ type: "speak_done", id: sid, cancelled: false }); }, 1);
          },
          on: (fn: (e: VoiceEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
        };
      },
    };
    ctx.provide("voice", svc);
  },
});

const toolResults: string[] = [];
const fakeBrain = definePlugin({
  manifest: { id: "fake-brain", version: "0", licence: "MIT", provides: ["brain"] },
  apply(ctx) {
    ctx.provide("brain", {
      name: "faux", reset: () => {},
      async *run(input) {
        if (/choisis/.test(input.text)) {
          const r = await ctx.tools.call("ask_choice", { question: "Quel fruit ?", options: ["Pomme", "Poire rouge", "Cerise"] }, { origin: input.origin ?? "" });
          toolResults.push(r.text);
          yield { type: "tool.result", name: "ask_choice", status: r.status };
          yield { type: "text", delta: "Noté." };
        } else yield { type: "text", delta: "Bonjour, je vais bien." };
        yield { type: "done", text: "" };
      },
    } as BrainService);
  },
});

describe("outil ask_choice", () => {
  let k: Kernel;
  let avatar: FakeBody; // voix + affichage, sans capacité « choice »
  let chat: FakeBody;   // texte, capable de « choice » mais pas d'origine
  afterEach(async () => { vi.restoreAllMocks(); await k.stopAll(); });

  async function setup(origin: "avatar" | "chat" = "avatar") {
    streams.clear(); toolResults.length = 0;
    k = new Kernel({ home: mkdtempSync(join(tmpdir(), "choice-")), logger: () => {}, plugins: [bodyHub, conversation, fakeBrain, fakeVoice, wakewordStt] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] }, slots: { "listen.wakeword": "stt/account" }, approvals: { timeout_s: 5 },
      plugins: [{ id: "stt", plugin: "wakeword-stt" }, { id: "body", plugin: "body-hub" }, { id: "voice", plugin: "fake-voice" }, { id: "brain", plugin: "fake-brain" },
        { id: "conv", plugin: "conversation", config: { free_listen_s: 2, neutral_after_ms: 50 } }],
    });
    const hub = k.service<BodyHub>("body")!;
    avatar = new FakeBody("avatar", ["voice", "display", "emotion"]);
    chat = new FakeBody("test", ["text", "choice"]);
    hub.attach(avatar.transport, { id: "avatar" }); avatar.hello();
    hub.attach(chat.transport, { id: "test" }); chat.hello();
    await vi.waitFor(() => expect(streams.has("avatar")).toBe(true));
    await new Promise<void>((r) => setImmediate(r));
    const st = streams.get("avatar")!;
    const ask = () => origin === "avatar" ? st.emit({ type: "transcript", text: "Floppy, choisis un fruit", audio_s: 1, stt_ms: 0, merged: false }) : chat.send({ type: "text", text: "choisis un fruit" });
    return { st, ask };
  }

  it("dit les options sur le corps vocal d'origine ; « la deuxième » répond et l'outil nomme l'option", async () => {
    const { st, ask } = await setup();
    ask();
    await vi.waitFor(() => expect(k.choices.pending()).toHaveLength(1));
    expect(k.choices.pending()[0]).toMatchObject({ origin: "avatar", title: "Quel fruit ?", ttl_s: 90 });
    await vi.waitFor(() => expect(st.spoken).toContain("Quel fruit ? un : Pomme, deux : Poire rouge, trois : Cerise."));
    st.emit({ type: "transcript", text: "la deuxième", audio_s: 0.6, stt_ms: 0, merged: false }); // sans mot d'activation
    await vi.waitFor(() => expect(toolResults).toEqual(["L'utilisateur a choisi : Poire rouge"]));
    expect(k.audit.tail(50).find((r) => r.kind === "choice")).toMatchObject({ picked: "o2", reason: "user", by: "avatar:voix" });
    await vi.waitFor(() => expect(avatar.of("reply.done")).toHaveLength(1));
    expect(k.choices.pending()).toHaveLength(0);
  });

  it("un « 2 » tapé répond sur un corps texte d'origine, et rien n'est dit", async () => {
    const { st, ask } = await setup("chat");
    ask();
    await vi.waitFor(() => expect(chat.of("choice.request")).toHaveLength(1));
    expect(k.choices.pending()[0]!.origin).toBe("test");
    chat.send({ type: "text", text: "2" });
    await vi.waitFor(() => expect(toolResults).toEqual(["L'utilisateur a choisi : Poire rouge"]));
    expect(st.spoken).toEqual([]);
    expect(chat.of("choice.closed")[0]).toMatchObject({ picked: "o2" });
    expect(k.audit.tail(50).find((r) => r.kind === "choice")).toMatchObject({ by: "test:voix" });
  });

  it("un corps qui n'est pas l'origine ne peut pas répondre (texte tapé ni voix)", async () => {
    const { st, ask } = await setup("chat");
    ask();
    await vi.waitFor(() => expect(k.choices.pending()).toHaveLength(1));
    st.emit({ type: "transcript", text: "Floppy, la deuxième", audio_s: 1, stt_ms: 0, merged: false });
    avatar.send({ type: "text", text: "2" });
    await new Promise((r) => setTimeout(r, 40));
    expect(k.choices.pending()).toHaveLength(1);
    expect(toolResults).toEqual([]);
  });

  it("une phrase sans rapport ne répond pas : elle suit son cours, le choix reste ouvert", async () => {
    const { ask } = await setup("chat");
    ask();
    await vi.waitFor(() => expect(k.choices.pending()).toHaveLength(1));
    chat.send({ type: "text", text: "quelle heure est-il ?" });
    // Traitée comme une nouvelle demande (elle interrompt le tour en cours), pas comme une réponse au choix.
    await vi.waitFor(() => expect(k.audit.tail(50).some((r) => r.kind === "turn.interrupted")).toBe(true));
    expect(k.choices.pending()).toHaveLength(1);
    expect(toolResults).toEqual([]);
  });

  it("sans réponse : résultat « aucun choix », sans consigne de réessayer", async () => {
    const real = globalThis.setTimeout;
    // Le délai du choix (90 s) est raccourci ; les autres minuteries gardent leur durée.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => real(fn, ms === 90_000 ? 30 : ms)) as typeof setTimeout);
    const { ask } = await setup("chat");
    ask();
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    expect(toolResults[0]).toContain("Aucun choix fait");
    expect(toolResults[0]).toContain("Ne repose pas la question");
    expect(k.audit.tail(50).find((r) => r.kind === "choice")).toMatchObject({ reason: "timeout" });
  });

  it("une entrée invalide donne un échec lisible, sans question posée", async () => {
    await setup("chat");
    const r = await k.tools.call("ask_choice", { question: "Quoi ?", options: ["seule"] }, { origin: "test" });
    expect(r.status).toBe("failed");
    expect(k.choices.pending()).toHaveLength(0);
  });
});
