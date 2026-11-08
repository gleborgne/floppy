import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, MemoryAudit, definePlugin } from "@floppy/core";
import type { BrainRunInput, BrainService, MemoryService } from "@floppy/contracts";
import aisdk from "../src/index.ts";
import localMemory from "../../../memory/local/src/index.ts";
import vocabulary from "../../../voice/vocabulary/src/index.ts";
import { optionalContext as brainContext } from "../src/optional-context.ts";
import { optionalContext as conversationContext } from "../../../conversation/default/src/optional-context.ts";

describe("mémoire et vocabulaire réels avec un cerveau CLI simulé", () => {
  it("apprend une correction explicite, la fournit au prochain tour puis retire la correction oubliée", async () => {
    const requests: BrainRunInput[] = [];
    const fake = definePlugin({ manifest: { id: "cli", version: "0", licence: "MIT", provides: ["llm"] }, apply(c) {
      c.offer("llm", { items: () => [{ id: "model", label: "CLI" }], start(f) {
        f.provide("llm", { model: "cli", agent: { name: "cli", keepsHistory: true, reset() {}, async *run(input) {
          requests.push(input);
          if (input.text.startsWith("Non")) {
            const result = await c.tools.call("corriger_vocabulaire", { heard: "court team", canonical: "Core Team", scope: { domain: "m365.teams", account: "contoso", container: "engineering" }, evidence: { text: input.text } }, { session: input.session, origin: input.origin, turn: input.turn });
            expect(result.status).toBe("done");
          }
          yield { type: "text", delta: "Compris." };
        } } });
      } });
    } });
    let brain!: BrainService, memory!: MemoryService;
    const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["brain", "memory"] }, apply(c) { brain = c.get("brain"); memory = c.get("memory"); } });
    const k = new Kernel({ logger() {}, home: mkdtempSync(join(tmpdir(), "memory-integration-")), plugins: [localMemory, vocabulary, fake, aisdk, probe] });
    await k.applyConfig({ approvals: { toolRules: [{ source: "vocabulary", tool: "corriger_vocabulaire", level: "write", rule: "always" }] }, plugins: [
      { id: "memory", plugin: "memory" }, { id: "vocabulary", plugin: "vocabulary" }, { id: "cli", plugin: "cli" }, { id: "brain", plugin: "brain-aisdk" }, { id: "probe", plugin: "probe" },
    ] });
    const run = async (text: string) => { for await (const _ of brain.run({ text, session: "avatar", origin: "avatar", mode: "voice" })) { /* vider */ } };
    const currentMemory = () => {
      const text = requests.at(-1)!.context!.at(-1)!.text;
      expect(text).toContain("remplace le contexte mémorisé précédent");
      return (JSON.parse(text.slice(text.indexOf("{"))) as { memory: string }).memory;
    };
    try {
      await run("Lis le canal court team");
      await run("Non, je dis Core Team");
      const saved = await memory.corrections!();
      expect(saved).toHaveLength(1);
      await run("Lis court team");
      expect(currentMemory()).toContain('"heard":"court team"');
      expect(currentMemory()).toContain('"canonical":"Core Team"');
      const forgetting = k.tools.call("oublier_correction", { id: saved[0]!.id }, { session: "avatar", origin: "avatar" });
      await vi.waitFor(() => expect(k.approvals.pending()).toHaveLength(1));
      k.approvals.respond(k.approvals.pending()[0]!.id, true, "test");
      expect((await forgetting).status).toBe("done");
      await run("Lis court team");
      expect(currentMemory()).not.toContain('"heard":"court team"');
      expect(await memory.corrections!()).toEqual([]);
      const trace = k.audit.tail(300);
      expect(trace).toContainEqual(expect.objectContaining({ kind: "memory.context", service: "vocabulary", consumer: "brain", session: "avatar", origin: "avatar", turn: expect.any(String), outcome: "ready", duration_ms: expect.any(Number) }));
      expect(JSON.stringify(trace.filter(r => r.kind === "memory.context"))).not.toContain("court team");
    } finally { await k.stopAll(); }
  });
});

describe.each([["brain", brainContext], ["conversation", conversationContext]] as const)("contexte facultatif %s", (_name, optional) => {
  it("ne lance aucun travail déjà annulé et distingue panne, délai et vide sans journaliser les données", async () => {
    const audit = new MemoryAudit(), ctx = { audit, log: vi.fn() };
    const operation = { service: "memory" as const, consumer: "brain" as const, phase: "snapshot" as const, session: "avatar", origin: "avatar", turn: "turn-test", available: true };
    const canceled = new AbortController(); canceled.abort();
    const work = vi.fn(() => "privé");
    expect(await optional(work, ctx, { ...operation, parent: canceled.signal })).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(await optional(() => { throw new Error("contenu privé"); }, ctx, operation)).toBeUndefined();
    expect(await optional(() => "", ctx, operation)).toBe("");
    expect(await optional(() => new Promise(() => {}), ctx, operation)).toBeUndefined();
    expect(audit.records.map(r => r.outcome)).toEqual(["aborted", "failed", "ready", "timeout"]);
    expect(audit.records.map(r => r.reason)).toEqual(["turn_aborted", "provider_error", undefined, "deadline"]);
    expect(JSON.stringify(audit.records)).not.toContain("privé");
  });
  it("annule la lecture active avec le tour parent", async () => {
    const parent = new AbortController(), ctx = { audit: new MemoryAudit(), log: vi.fn() };
    let signal!: AbortSignal;
    const pending = optional(s => { signal = s; return new Promise(() => {}); }, ctx, { service: "memory", consumer: "brain", phase: "snapshot", session: "avatar", turn: "turn-active", available: true, parent: parent.signal });
    await Promise.resolve(); parent.abort();
    expect(await pending).toBeUndefined(); expect(signal.aborted).toBe(true);
    expect(ctx.audit.records.at(-1)).toMatchObject({ outcome: "aborted", reason: "turn_aborted" });
  });
});
