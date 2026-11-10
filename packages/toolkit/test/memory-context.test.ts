import { describe, expect, it, vi } from "vitest";
import { MemoryAudit } from "@floppy/core";
import type { MemoryContextDeps } from "@floppy/contracts";
import { memoryContextMessage, prepareMemoryContext, MEMORY_OPERATION_TIMEOUT_MS } from "../src/memory-context.ts";

const input = { session: "avatar", turn: "turn", heard: "court team", language: "fr" };
const diagnostics = () => ({ log: vi.fn(), audit: new MemoryAudit() });
describe("contexte mémoire partagé", () => {
  it("prépare les mêmes données et disponibilités pour chaque consommateur et chaque langue", async () => {
    for (const language of ["fr", "en"]) {
      const deps: MemoryContextDeps = { diagnostics: diagnostics(), memory: { snapshot: () => ({ user: "Profil", memory: "" }), record() {}, search: () => [] }, vocabulary: { observe() {}, context: async () => { throw new Error("privé"); }, resolve: async () => ({ status: "none", candidates: [] }) } };
      const messages = [];
      for (const consumer of ["brain", "conversation", "live"] as const) {
        const data = await prepareMemoryContext(deps, { ...input, language, consumer });
        expect(data).toMatchObject({ user: "Profil", memory: "", vocabulary: "", availability: { memory: "ready", vocabulary: "unavailable" } });
        messages.push(memoryContextMessage(data!, language));
      }
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toContain(language === "en" ? "temporarily unavailable" : "temporairement indisponible");
      expect(JSON.stringify(deps.diagnostics.audit)).not.toContain("privé");
    }
  });
  it("distingue les fournisseurs absents des données vides disponibles", async () => {
    expect(await prepareMemoryContext({ diagnostics: diagnostics() }, { ...input, consumer: "brain" })).toBeUndefined();
    const data = await prepareMemoryContext({ diagnostics: diagnostics(), vocabulary: { observe() {}, context: async () => "", resolve: async () => ({ status: "none", candidates: [] }) } }, { ...input, consumer: "live" });
    expect(data).toMatchObject({ vocabulary: "", availability: { memory: "absent", vocabulary: "ready" } });
    expect(data?.warning).toBeUndefined();
  });
  it("accepte un fournisseur distant de 600 ms dans le budget commun", async () => {
    expect(MEMORY_OPERATION_TIMEOUT_MS).toBeGreaterThan(600);
    const snapshot = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 600)); return { user: "Distant", memory: "" }; });
    const data = await prepareMemoryContext({ diagnostics: diagnostics(), memory: { snapshot, record() {}, search: () => [] } }, { ...input, consumer: "conversation" });
    expect(data).toMatchObject({ user: "Distant", availability: { memory: "ready", vocabulary: "absent" } });
  });
});
