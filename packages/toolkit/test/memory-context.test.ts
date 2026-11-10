import { describe, expect, it, vi } from "vitest";
import { MemoryAudit } from "@floppy/core";
import type { MemoryContextDeps } from "@floppy/contracts";
import { memoryContextMessage, prepareMemoryContext, turnMemory, MEMORY_OPERATION_TIMEOUT_MS } from "../src/memory-context.ts";

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

describe("turnMemory", () => {
  const turn = { session: "avatar", origin: "avatar", turn: "t1", consumer: "conversation" as const, language: "fr" };
  const services = () => {
    const memory = { snapshot: vi.fn(() => ({ user: "Profil", memory: "" })), record: vi.fn(), search: () => [] };
    const vocabulary = { observe: vi.fn(), context: vi.fn(async () => "mots"), resolve: async () => ({ status: "none" as const, candidates: [] }) };
    return { memory, vocabulary };
  };
  it("observe, prépare et enregistre avec la corrélation et l'audit", async () => {
    const { memory, vocabulary } = services();
    const deps = { diagnostics: diagnostics(), memory, vocabulary };
    const tm = turnMemory(deps, turn);
    await tm.observe("bonjour");
    const data = await tm.prepare("bonjour");
    await tm.record("user", "bonjour");
    expect(vocabulary.observe).toHaveBeenCalledWith({ text: "bonjour", session: "avatar", origin: "avatar", turn: "t1" });
    expect(data).toMatchObject({ user: "Profil", vocabulary: "mots" });
    expect(memory.record).toHaveBeenCalledWith({ session: "avatar", origin: "avatar", role: "user", text: "bonjour" }, expect.objectContaining({ session: "avatar", turn: "t1" }));
    const phases = deps.diagnostics.audit.records.map(r => `${r.service}.${r.phase}`);
    expect(phases).toEqual(expect.arrayContaining(["vocabulary.observe", "memory.snapshot", "vocabulary.context", "memory.record"]));
    expect(deps.diagnostics.audit.records.every(r => r.kind === "memory.context" && r.consumer === "conversation" && r.turn === "t1" && r.outcome === "ready")).toBe(true);
  });
  it("sans fournisseur : rien, pas d'erreur", async () => {
    const deps = { diagnostics: diagnostics() };
    const tm = turnMemory(deps, { session: "s", turn: "t", consumer: "brain", language: "en" });
    await tm.observe("x");
    expect(await tm.prepare("x")).toBeUndefined();
    await tm.record("assistant", "x");
    expect(deps.diagnostics.audit.records.every(r => r.outcome === "unavailable")).toBe(true);
  });
  it("ignore un texte vide", async () => {
    const { memory } = services();
    const tm = turnMemory({ diagnostics: diagnostics(), memory }, turn);
    await tm.record("user", "  ");
    expect(memory.record).not.toHaveBeenCalled();
  });
  it("detached enregistre malgré un signal annulé ; sans detached, rien", async () => {
    const { memory } = services();
    const stop = new AbortController(); stop.abort();
    const tm = turnMemory({ diagnostics: diagnostics(), memory }, { ...turn, signal: stop.signal });
    await tm.record("assistant", "coupé");
    expect(memory.record).not.toHaveBeenCalled();
    await tm.record("assistant", "coupé", { detached: true });
    expect(memory.record).toHaveBeenCalledTimes(1);
  });
});
