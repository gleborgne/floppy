import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, definePlugin } from "@floppy/core";
import type { BodyHub, BrainRunInput, MemoryService } from "@floppy/contracts";
import type { BodyToKernel, BodyTransport, KernelToBody } from "@floppy/protocol";
import bodyHub from "@floppy/plugin-body-hub";
import conversation from "../src/index.ts";

async function fixture(managesMemory = false) {
  const requests: BrainRunInput[] = [], sent: KernelToBody[] = [];
  let note = "Profil initial";
  const record = vi.fn<MemoryService["record"]>(async () => {});
  const snapshot = vi.fn<MemoryService["snapshot"]>(async () => ({ user: "Utilisateur", memory: note }));
  const observe = vi.fn(), unbind = vi.fn(), bind = vi.fn(() => unbind);
  const fake = definePlugin({ manifest: { id: "fake", version: "0", licence: "MIT", provides: ["brain", "memory", "vocabulary", "mcp"] }, apply(c) {
    c.provide("brain", { name: "cli-direct", managesMemory, reset() {}, async *run(input) {
      requests.push(input); yield { type: "text", delta: "Bonjour." };
    } });
    c.provide("memory", { snapshot, record, search: () => [] });
    c.provide("vocabulary", { observe, context: async () => note, resolve: async () => ({ status: "none", candidates: [] }) });
    c.provide("mcp", { url: "unused", token: "unused", bindContext: bind, scoped() { throw new Error("inutilisé"); } });
  } });
  const k = new Kernel({ logger() {}, home: mkdtempSync(join(tmpdir(), "conversation-memory-")), plugins: [bodyHub, fake, conversation] });
  await k.applyConfig({ plugins: [{ id: "body", plugin: "body-hub" }, { id: "fake", plugin: "fake" }, { id: "conversation", plugin: "conversation" }] });
  let receive!: (message: BodyToKernel) => void;
  const transport: BodyTransport = { send: message => { sent.push(message); }, sendAudio() {}, onMessage(fn) { receive = fn; }, onAudio() {}, onClose() {}, close() {} };
  k.service<BodyHub>("body")!.attach(transport, { id: "text-body" });
  receive({ type: "hello", id: "text-body", name: "Texte", version: "0", capabilities: ["display"], tools: [] });
  const run = async (text: string) => {
    const count = sent.filter(m => m.type === "reply.done").length;
    receive({ type: "text", text });
    await vi.waitFor(() => expect(sent.filter(m => m.type === "reply.done")).toHaveLength(count + 1));
  };
  return { k, requests, record, snapshot, observe, bind, unbind, run, setNote: (value: string) => { note = value; } };
}

describe("mémoire de la conversation avec un cerveau direct", () => {
  it("fournit les données à chaque tour et garde une seule paire de messages", async () => {
    const f = await fixture();
    try {
      await f.run("Lis corps team");
      f.setNote("corps team → Core Team");
      await f.run("Non, je dis Core Team");
      expect(f.requests[1]!.text).toBe("Non, je dis Core Team");
      expect(JSON.stringify(f.requests[1]!.context)).toContain("Core Team");
      expect(f.observe.mock.calls.map(([e]) => e.text)).toEqual(["Lis corps team", "Non, je dis Core Team"]);
      expect(f.record.mock.calls.map(([e]) => [e.role, e.text])).toEqual([
        ["user", "Lis corps team"], ["assistant", "Bonjour."], ["user", "Non, je dis Core Team"], ["assistant", "Bonjour."],
      ]);
      expect(f.snapshot).toHaveBeenCalledTimes(2);
      expect(f.bind).toHaveBeenCalledTimes(2); expect(f.unbind).toHaveBeenCalledTimes(2);
    } finally { await f.k.stopAll(); }
  });
  it("laisse un cerveau qui gère la mémoire enregistrer et observer lui-même", async () => {
    const f = await fixture(true);
    try {
      await f.run("Bonjour");
      expect(f.record).not.toHaveBeenCalled(); expect(f.snapshot).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
    } finally { await f.k.stopAll(); }
  });
});
