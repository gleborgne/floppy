// Garde-fou « fausse action » : la relance traite `deleguer` comme le chemin principal (phrase d'attente + arrêt).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainService, BrainEvent, BrainRunInput } from "@floppy/contracts";
import llamacpp from "../../../llm/llamacpp/src/index.ts";
import aisdk, { WAIT_PHRASES } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "brain-fake-"));
const gguf = join(dir, "a.gguf");
writeFileSync(gguf, Buffer.alloc(1024));

const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const textReply = (t: string) => chunk({ role: "assistant", content: t }) + chunk({}, "stop") + "data: [DONE]\n\n";
const toolReply = (name: string, args: string) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: args } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";

let calls = 0;
let repeatedClaim = false;
let claimText = "C'est fait, j'ai ouvert les réglages.";
let server: Server, k: Kernel;
let brain: BrainService | undefined;
let delegated = 0;
let delegateEmotion = false;
const agentInputs: string[] = [];
const requests: BrainRunInput[] = [];
const resets: string[] = [];
const unbind = vi.fn(), bind = vi.fn(() => unbind), observe = vi.fn();
const snapshot = vi.fn(() => ({ user: "", memory: "Mémoire du tour source" }));
const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(ctx) { brain = ctx.get("brain"); } });
const bigModel: BrainService = {
  name: "gros", label: "Gros Modèle", aliases: ["gros"],
  reset(session) { resets.push(session); },
  async *run(input) { delegated++; agentInputs.push(input.text); requests.push(input); if (delegateEmotion) yield { type: "emotion", emotion: "proud", intensity: 1.25 } as BrainEvent; yield { type: "text", delta: "Réponse du grand modèle." } as BrainEvent; yield { type: "done", text: "" } as BrainEvent; },
};
// Offert comme délégué (slot brain.delegate) et comme modèle-agent (slot brain.main), comme Claude Code.
const fakeDelegate = definePlugin({
  manifest: { id: "fakedelegate", version: "0", licence: "MIT", provides: ["delegate", "llm", "mcp", "memory", "vocabulary"] },
  apply(ctx) {
    ctx.provide("mcp", { url: "unused", token: "unused", bindContext: bind, scoped() { throw new Error("inutilisé"); } });
    ctx.provide("memory", { snapshot, record() {}, search: () => [] });
    ctx.provide("vocabulary", { observe, context: async () => "", resolve: async () => ({ status: "none", candidates: [] }) });
    ctx.offer("delegate", { items: () => [{ id: "gros", label: "Gros Modèle" }], start(f) { f.provide("delegate", bigModel); } });
    ctx.offer("llm", { items: () => [{ id: "gros", label: "Gros Modèle" }], start(f) { f.provide("llm", { label: "Gros Modèle", model: "gros", agent: bigModel }); } });
  },
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") {
        calls++;
        res.setHeader("content-type", "text/event-stream");
        // 1er appel : « C'est fait » sans outil (fausse action) ; 2e appel (relance) : délègue ; un 3e serait une faute.
        res.end(repeatedClaim ? textReply(claimText) : calls === 1 ? textReply("C'est fait.") : toolReply("deleguer", JSON.stringify({ tache: "écris un script" })));
      } else {
        res.setHeader("content-type", "application/json");
        res.end(req.url === "/v1/models" ? JSON.stringify({ data: [{ id: "gemma" }] }) : "{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  k = new Kernel({ logger: () => {}, home: join(dir, "home"), plugins: [llamacpp, aisdk, fakeDelegate, probe] });
  await k.applyConfig({ slots: { "brain.main": "llm/gemma", "brain.delegate": "fd/gros" }, plugins: [
    { id: "llm", plugin: "llm-llamacpp", config: { port, models: { gemma: { label: "Gemma", model: gguf } } } },
    { id: "fd", plugin: "fakedelegate" },
    { id: "brain", plugin: "brain-aisdk", config: { emotions: false } },
    { id: "probe", plugin: "probe" },
  ] });
  await k.idle();
});
afterAll(async () => { await k.stopAll(); await new Promise((r) => server.close(r)); });

describe("relance après fausse action", () => {
  it("le cerveau tourne avec le modèle local de son slot (fork du plugin llama.cpp)", () => {
    expect(brain!.name).toContain("gemma");
    expect(brain!.name).toContain("gros"); // délégué du slot brain.delegate
    expect(k.status().find((s) => s.id === "llm/llm/gemma")?.state).toBe("active");
  });
  it("ne prononce pas une seconde fausse confirmation sans outil", async () => {
    repeatedClaim = true;
    const evs: BrainEvent[] = [];
    try {
      for await (const ev of brain!.run({ text: "Ouvre tes réglages", session: "repeated", mode: "text" })) evs.push(ev);
      const text = evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
      expect(text).not.toContain("C'est fait");
      expect(text).not.toContain("j'ai ouvert");
      expect(text).toContain("aucune action");
    } finally { repeatedClaim = false; calls = 0; }
  });
  it("si la relance délègue : phrase d'attente, réponse du grand modèle, puis arrêt", async () => {
    const evs: BrainEvent[] = [];
    const reads = snapshot.mock.calls.length, observations = observe.mock.calls.length;
    const abort = new AbortController();
    for await (const ev of brain!.run({ text: "écris-moi un script", session: "s", origin: "avatar", turn: "source-turn", mode: "text", tone: "joueur", signal: abort.signal })) evs.push(ev);
    const text = evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(WAIT_PHRASES.some((p) => text.includes(p))).toBe(true);
    expect(text).toContain("Réponse du grand modèle.");
    expect(text).not.toContain("C'est fait");
    expect(evs.some((e) => e.type === "delegate")).toBe(true);
    expect(delegated).toBe(1);
    expect(requests.at(-1)?.tone).toBe("joueur");
    const delegatedInput = requests.at(-1)!;
    expect(delegatedInput).toMatchObject({ session: "s:delegate", turn: "source-turn", recordMemory: false, memoryContext: { memory: "Mémoire du tour source" }, toolContext: { session: "s", origin: "avatar", turn: "source-turn" } });
    expect(delegatedInput.toolContext!.signal).toBe(delegatedInput.signal);
    expect(bind).toHaveBeenLastCalledWith(delegatedInput.toolContext);
    expect(unbind).toHaveBeenCalled();
    expect(snapshot.mock.calls.length - reads).toBe(1);
    expect(observe.mock.calls.slice(observations)).toEqual([[expect.objectContaining({ text: "écris-moi un script", session: "s", turn: "source-turn" })]]);
    expect(JSON.stringify(delegatedInput.context)).toContain("Mémoire du tour source");
    brain!.reset("s");
    expect(resets).toContain("s:delegate");
    expect(calls).toBe(2); // pas de 3e appel : la boucle s'arrête après la délégation
  });
  it("retient aussi une promesse d'ouverture précédée d'une formule polie", async () => {
    repeatedClaim = true;
    claimText = "Avec plaisir ! Je t'ouvre ça tout de suite.";
    try {
      const evs: BrainEvent[] = [];
      for await (const ev of brain!.run({ text: "Ouvre tes réglages", session: "promise", mode: "text" })) evs.push(ev);
      const text = evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
      expect(text).not.toContain("Je t'ouvre");
      expect(text).toContain("aucune action");
    } finally { repeatedClaim = false; }
  });
});

describe("délégation : émotion du délégué", () => {
  it("l'émotion du délégué suit le visage (réglage actif) ; coupé, elle est ignorée ; son texte reste sans étiquette", async () => {
    const run = async () => {
      calls = 2; // le modèle local délègue tout de suite
      const evs: BrainEvent[] = [];
      for await (const ev of brain!.run({ text: "écris-moi un autre script", session: "deleg-emotion", mode: "text" })) evs.push(ev);
      return evs;
    };
    delegateEmotion = true;
    try {
      const off = await run();
      expect(off.some((e) => e.type === "emotion")).toBe(false);
      const port = (server.address() as AddressInfo).port;
      await k.applyConfig({ slots: { "brain.main": "llm/gemma", "brain.delegate": "fd/gros" }, plugins: [
        { id: "llm", plugin: "llm-llamacpp", config: { port, models: { gemma: { label: "Gemma", model: gguf } } } },
        { id: "fd", plugin: "fakedelegate" },
        { id: "brain", plugin: "brain-aisdk", config: { emotions: true } },
        { id: "probe", plugin: "probe" },
      ] });
      await k.idle();
      const on = await run();
      expect(on.filter((e) => e.type === "emotion")).toEqual([{ type: "emotion", emotion: "proud", intensity: 1.25 }]);
      expect(on.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("Réponse du grand modèle.");
    } finally {
      delegateEmotion = false;
      calls = 0;
    }
  });
});

describe("modèle-agent (llm.agent)", () => {
  it("un agent choisi comme cerveau principal reçoit le tour entier ; le LLM local est libéré", async () => {
    const before = delegated;
    expect((await k.settings.change("slot.brain.main", "fd/gros", "cli")).ok).toBe(true);
    expect(k.status().find((s) => s.id === "llm/llm/gemma")).toBeUndefined();
    let text = "";
    for await (const ev of brain!.run({ text: "Bonjour", session: "agent", mode: "text" })) if (ev.type === "text") text += ev.delta;
    expect(text).toContain("Réponse du grand modèle.");
    expect(delegated).toBe(before + 1);
    expect(agentInputs.at(-1)).toBe("Bonjour"); // 1re demande : rien à redonner
    // Un agent sans historique reçoit toujours les échanges précédents.
    for await (const _ of brain!.run({ text: "Elle est pourrie ta blague", session: "agent", mode: "text" })) { /* vide */ }
    expect(agentInputs.at(-1)).toMatch(/Utilisateur : Bonjour\nToi : Réponse du grand modèle\.[\s\S]*Demande courante : Elle est pourrie ta blague$/);
    // Une autre conversation (autre corps) ne voit pas ces échanges ; reset les oublie.
    for await (const _ of brain!.run({ text: "Salut", session: "autre", mode: "text" })) { /* vide */ }
    expect(agentInputs.at(-1)).toBe("Salut");
    brain!.reset("agent");
    expect(resets).toContain("agent");
    for await (const _ of brain!.run({ text: "Et maintenant ?", session: "agent", mode: "text" })) { /* vide */ }
    expect(agentInputs.at(-1)).toBe("Et maintenant ?");
    expect((await k.settings.change("slot.brain.main", "llm/gemma", "cli")).ok).toBe(true);
  });
  it("relaie l'émotion d'un agent cerveau principal, sans toucher à son texte déjà filtré", async () => {
    delegateEmotion = true;
    try {
      expect((await k.settings.change("slot.brain.main", "fd/gros", "cli")).ok).toBe(true);
      const evs: BrainEvent[] = [];
      for await (const ev of brain!.run({ text: "Bonjour", session: "emotion-agent", mode: "text" })) evs.push(ev);
      expect(evs.filter((e) => e.type === "emotion")).toEqual([{ type: "emotion", emotion: "proud", intensity: 1.25 }]);
      expect(evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Réponse du grand modèle.");
    } finally {
      delegateEmotion = false;
      await k.settings.change("slot.brain.main", "llm/gemma", "cli");
    }
  });
  it("n'envoie pas l'historique en double à un agent persistant ; fournit un secours et relaie reset", async () => {
    bigModel.keepsHistory = true;
    try {
      expect((await k.settings.change("slot.brain.main", "fd/gros", "cli")).ok).toBe(true);
      for await (const _ of brain!.run({ text: "Bonjour", session: "persistant", mode: "text", tone: "joueur" })) { /* vide */ }
      for await (const _ of brain!.run({ text: "Suite", session: "persistant", mode: "text", tone: "joueur" })) { /* vide */ }
      expect(requests.at(-1)).toMatchObject({ text: "Suite", tone: "joueur", history: [
        { role: "user", text: "Bonjour" }, { role: "assistant", text: "Réponse du grand modèle." },
      ] });
      brain!.reset("persistant");
      expect(resets).toContain("persistant");
      for await (const _ of brain!.run({ text: "Neuf", session: "persistant", mode: "text" })) { /* vide */ }
      expect(requests.at(-1)).toMatchObject({ text: "Neuf", history: [] });
    } finally {
      bigModel.keepsHistory = false;
      await k.settings.change("slot.brain.main", "llm/gemma", "cli");
    }
  });
});
