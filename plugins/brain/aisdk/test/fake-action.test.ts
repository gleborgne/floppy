// Garde-fou « fausse action » : la relance traite `deleguer` comme le chemin principal (phrase d'attente + arrêt).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Kernel, definePlugin, type BrainService, type BrainEvent } from "@floppy/core";
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
const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(ctx) { brain = ctx.get("brain"); } });
const bigModel: BrainService = {
  name: "gros", label: "Gros Modèle", aliases: ["gros"],
  reset() {},
  async *run() { delegated++; yield { type: "text", delta: "Réponse du grand modèle." } as BrainEvent; yield { type: "done", text: "" } as BrainEvent; },
};
// Offert comme délégué (slot brain.delegate) et comme modèle-agent (slot brain.main), comme Claude Code.
const fakeDelegate = definePlugin({
  manifest: { id: "fakedelegate", version: "0", licence: "MIT", provides: ["delegate", "llm"] },
  apply(ctx) {
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
    for await (const ev of brain!.run({ text: "écris-moi un script", session: "s", mode: "text" })) evs.push(ev);
    const text = evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(WAIT_PHRASES.some((p) => text.includes(p))).toBe(true);
    expect(text).toContain("Réponse du grand modèle.");
    expect(text).not.toContain("C'est fait");
    expect(evs.some((e) => e.type === "delegate")).toBe(true);
    expect(delegated).toBe(1);
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

describe("modèle-agent (llm.agent)", () => {
  it("un agent choisi comme cerveau principal reçoit le tour entier ; le LLM local est libéré", async () => {
    const before = delegated;
    expect((await k.settings.change("slot.brain.main", "fd/gros", "cli")).ok).toBe(true);
    expect(k.status().find((s) => s.id === "llm/llm/gemma")).toBeUndefined();
    let text = "";
    for await (const ev of brain!.run({ text: "Bonjour", session: "agent", mode: "text" })) if (ev.type === "text") text += ev.delta;
    expect(text).toContain("Réponse du grand modèle.");
    expect(delegated).toBe(before + 1);
    expect((await k.settings.change("slot.brain.main", "llm/gemma", "cli")).ok).toBe(true);
  });
});
