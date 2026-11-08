import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, definePlugin } from "@floppy/core";
import type { BrainRunInput, BrainService, MemoryService, PreparedMemoryContext } from "@floppy/contracts";
import aisdk from "../src/index.ts";

async function fixture(agent: boolean, agentManagesMemory = false) {
  const requests: BrainRunInput[] = [], bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", d => { body += d; });
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      res.setHeader("content-type", "text/event-stream");
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk({ role: "assistant", content: "Bonjour." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  let note = "Ancienne préférence";
  const snapshot = vi.fn<MemoryService["snapshot"]>(async () => ({ user: "Profil", memory: note }));
  const record = vi.fn<MemoryService["record"]>(async () => {});
  const observe = vi.fn();
  const context = vi.fn(async () => note);
  const unbind = vi.fn();
  const bind = vi.fn(() => unbind);
  const provider = definePlugin({ manifest: { id: "fake", version: "0", licence: "MIT", provides: ["llm", "memory", "vocabulary", "mcp"] }, apply(c) {
    c.provide("memory", { snapshot, record, search: () => [] });
    c.provide("vocabulary", { observe, context, resolve: async () => ({ status: "none", candidates: [] }) });
    c.provide("mcp", { url: "unused", token: "unused", bindContext: bind, scoped() { throw new Error("inutilisé"); } });
    c.offer("llm", { items: () => [{ id: "model", label: "Test" }], start(f) {
      f.provide("llm", agent ? { model: "cli", agent: { name: "cli", managesMemory: agentManagesMemory, keepsHistory: true, reset() {}, async *run(input) {
        requests.push(input); yield { type: "text", delta: "[content] Bonjour." };
      } } } : { model: "local", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    } });
  } });
  let brain!: BrainService;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain"] }, apply(c) { brain = c.get("brain"); } });
  const k = new Kernel({ logger() {}, home: mkdtempSync(join(tmpdir(), "brain-memory-")), plugins: [provider, aisdk, probe] });
  await k.applyConfig({ plugins: [{ id: "fake", plugin: "fake" }, { id: "brain", plugin: "brain-aisdk", config: { emotions: false } }, { id: "probe", plugin: "probe" }] });
  const run = async (text: string, recordMemory = true, memoryContext?: PreparedMemoryContext | null) => {
    let result = "";
    for await (const e of brain.run({ text, session: "avatar", origin: "avatar", mode: "voice", recordMemory, ...(memoryContext !== undefined ? { memoryContext } : {}) })) if (e.type === "text") result += e.delta;
    return result;
  };
  return { requests, bodies, snapshot, record, observe, context, bind, unbind, run,
    setNote: (value: string) => { note = value; },
    close: async () => { await k.stopAll(); await new Promise<void>(r => server.close(() => r())); } };
}

describe("mémoire des cerveaux", () => {
  it("transmet une photo unique à un modèle-agent qui possède sa mémoire", async () => {
    const f = await fixture(true, true);
    try {
      await f.run("Bonjour");
      expect(f.requests[0]!.context).toBeUndefined();
      expect(f.requests[0]!.memoryContext).toMatchObject({ user: "Profil", memory: "Ancienne préférence", availability: { memory: "ready", vocabulary: "ready" } });
      expect(f.requests[0]!.recordMemory).toBe(false);
      expect(f.snapshot).toHaveBeenCalledOnce(); expect(f.observe).toHaveBeenCalledOnce();
      expect(f.record.mock.calls.map(([entry]) => entry.role)).toEqual(["user", "assistant"]);
    } finally { await f.close(); }
  });
  it.each([false, true])("réutilise une photo Live sans lecture ni contexte contradictoire (CLI %s)", async agent => {
    const f = await fixture(agent);
    try {
      const memoryContext: PreparedMemoryContext = { user: "Profil Live", memory: "Photo Live", vocabulary: "", availability: { memory: "ready", vocabulary: "unavailable" }, warning: "Source indisponible" };
      await f.run("Bonjour", false, memoryContext);
      expect(f.snapshot).not.toHaveBeenCalled(); expect(f.context).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
      const rendered = agent ? f.requests[0]!.context!.map(c => c.text).join("\n") : f.bodies[0]!.messages[0]!.content;
      expect(rendered.match(/Photo Live/g)).toHaveLength(1);
      expect(rendered).toContain('"vocabulary":"unavailable"');
      expect(rendered).not.toContain("Ancienne préférence");
      await f.run("Encore", false, null);
      expect(f.snapshot).not.toHaveBeenCalled(); expect(f.context).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("distingue une mémoire vide autoritaire d'une mémoire indisponible dans le contexte CLI", async () => {
    const f = await fixture(true);
    try {
      f.snapshot.mockResolvedValue({ user: "", memory: "" }); f.context.mockResolvedValue("");
      await f.run("Bonjour");
      expect(JSON.stringify(f.requests.at(-1)!.context)).toContain("seules les corrections listées sont actives");
      expect(JSON.stringify(f.requests.at(-1)!.context)).not.toContain("indisponible");
      f.snapshot.mockRejectedValue(new Error("hors ligne")); f.context.mockRejectedValue(new Error("hors ligne"));
      await f.run("Encore");
      expect(JSON.stringify(f.requests.at(-1)!.context)).toContain("temporairement indisponible");
      expect(JSON.stringify(f.requests.at(-1)!.context)).not.toContain("oubliée");
    } finally { await f.close(); }
  });
  it.each([false, true])("rafraîchit les données au tour suivant et enregistre chaque échange une fois (CLI %s)", async agent => {
    const f = await fixture(agent);
    try {
      await f.run("Lis le canal corps team");
      f.setNote("corps team → Core Team");
      await f.run("Non, je dis Core Team");
      const serialized = agent ? JSON.stringify(f.requests[1]!.context) : f.bodies[1]!.messages[0]!.content;
      expect(serialized).toContain("Core Team");
      expect(serialized).toMatch(/données|data/);
      expect(f.snapshot).toHaveBeenCalledTimes(2);
      expect(f.record.mock.calls.map(([e]) => [e.role, e.text])).toEqual([
        ["user", "Lis le canal corps team"], ["assistant", "Bonjour."],
        ["user", "Non, je dis Core Team"], ["assistant", "Bonjour."],
      ]);
      expect(f.observe.mock.calls.map(([e]) => e.text)).toEqual(["Lis le canal corps team", "Non, je dis Core Team"]);
      expect(f.context).toHaveBeenLastCalledWith(expect.objectContaining({ heard: "Non, je dis Core Team", session: "avatar", origin: "avatar", turn: expect.any(String) }));
      if (agent) {
        expect(f.requests[1]!.text).toBe("Non, je dis Core Team");
        expect(f.bind).toHaveBeenCalledTimes(2); expect(f.unbind).toHaveBeenCalledTimes(2);
      }
    } finally { await f.close(); }
  });

  it("la délégation Live laisse son propriétaire enregistrer le tour", async () => {
    const f = await fixture(true);
    try {
      await f.run("Bonjour", false);
      expect(f.record).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
      expect(f.requests[0]!.context).toBeDefined();
    } finally { await f.close(); }
  });

  it("une mémoire asynchrone muette ou rejetée ne bloque pas le cerveau et reçoit son signal borné", async () => {
    const f = await fixture(true);
    try {
      f.snapshot.mockImplementation(() => new Promise(() => {}));
      f.record.mockRejectedValue(new Error("indisponible"));
      const started = performance.now();
      expect(await f.run("Bonjour")).toBe("Bonjour.");
      expect(performance.now() - started).toBeLessThan(3500);
      expect(f.snapshot.mock.calls[0]![0]!.signal!.aborted).toBe(true);
    } finally { await f.close(); }
  });
});
