import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kernel, MemoryAudit, type AuditRecord } from "@floppy/core";
import type { MemoryCorrectionInput, MemoryService } from "@floppy/contracts";
import memory from "../src/index.ts";
import { correctionStore } from "../src/corrections.ts";

const correction: MemoryCorrectionInput = {
  heard: "private heard", canonical: "Private Canonical", scope: { domain: "private domain", account: "private account", container: "private container" },
  evidence: { text: "private evidence", session: "private evidence session" },
  target: { kind: "private kind", id: "private target" },
};
const correlation = { session: "session-1", origin: "body-1", turn: "turn-1", callId: "call-1" };
const kernels: Kernel[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of kernels.splice(0)) await k.stopAll();
  for (const db of dbs.splice(0)) db.close();
});
async function start(home = mkdtempSync(join(tmpdir(), "memory-audit-"))) {
  const audit = new MemoryAudit();
  const k = new Kernel({ home, audit, logger: () => {}, plugins: [memory] }); kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "memory-local", plugin: "memory" }] });
  const events = () => audit.records.filter((r) => r.kind === "memory.store");
  return { k, home, events, service: k.service<MemoryService>("memory")! };
}
function privateFree(events: AuditRecord[]) {
  const data = JSON.stringify(events);
  for (const secret of ["private heard", "Private Canonical", "private domain", "private account", "private container", "private evidence", "private target", "private query", "private history"]) {
    expect(data).not.toContain(secret);
  }
  for (const event of events) {
    expect(event.duration_ms).toEqual(expect.any(Number));
    expect(event.duration_ms as number).toBeGreaterThanOrEqual(0);
  }
}

describe("audit du stockage mémoire", () => {
  it("suit la durabilité, les versions et les comptes sans texte ni portée en clair", async () => {
    const { k, home, service, events } = await start();
    expect(events()).toMatchObject([{ source: "memory-local", operation: "startup", status: "done", correctionsCount: 0 }]);
    const first = await service.saveCorrection!(correction, correlation);
    await service.saveCorrection!(correction, correlation);
    await service.saveCorrection!({ ...correction, canonical: "Other Private Canonical", replaces: { id: first.id, version: 1 } }, correlation);
    await service.corrections!({ scope: correction.scope, heard: correction.heard }, correlation);
    await service.record({ session: "private record session", role: "user", text: "private history" }, correlation);
    await service.search("private query", 5, correlation);
    await service.snapshot(correlation);
    expect(events().some((e) => e.operation === "snapshot")).toBe(false);
    const saves = events().filter((e) => e.operation === "correction.save");
    expect(saves).toMatchObject([
      { ...correlation, outcome: "inserted", correctionId: first.id, version: 1, count: 1, status: "done" },
      { ...correlation, outcome: "unchanged", correctionId: first.id, version: 1, count: 0, status: "done" },
      { ...correlation, outcome: "updated", correctionId: first.id, version: 2, count: 1, status: "done" },
    ]);
    expect(events().find((e) => e.operation === "correction.list")).toMatchObject({ count: 1, scopeFiltered: true, heardFiltered: true });
    expect(events().find((e) => e.operation === "history.record")).toMatchObject({ ...correlation, count: 1 });
    expect(events().find((e) => e.operation === "history.search")).toMatchObject({ ...correlation, count: 1 });
    await k.stopAll();
    const restored = await start(home);
    expect(restored.events()[0]).toMatchObject({ operation: "startup", correctionsCount: 1 });
    await restored.service.forgetCorrection!(first.id, correlation);
    await restored.service.forgetCorrection!(first.id, correlation);
    expect(restored.events().filter((e) => e.operation === "correction.delete")).toMatchObject([
      { ...correlation, outcome: "deleted", correctionId: first.id, count: 1 }, { ...correlation, outcome: "missing", correctionId: first.id, count: 0 },
    ]);
    privateFree([...events(), ...restored.events()]);
  });

  it("distingue refus, annulation et panne de stockage sans journaliser l'erreur brute", () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const audit = new MemoryAudit();
    const store = correctionStore(db, (event) => audit.write({ kind: "memory.store", source: "local", ...event }));
    expect(() => store.saveCorrection({ ...correction, heard: "" }, correlation)).toThrow();
    expect(() => store.saveCorrection(correction, { ...correlation, signal: AbortSignal.abort("private abort reason") })).toThrow();
    const failure = new Error("private history private query C:/private/path");
    vi.spyOn(db, "exec").mockImplementationOnce(() => { throw failure; });
    expect(() => store.saveCorrection(correction, correlation)).toThrow(failure);
    expect(audit.records).toMatchObject([
      { ...correlation, operation: "correction.save", status: "failed", reason: "rejected" },
      { ...correlation, operation: "correction.save", status: "cancelled", reason: "cancelled" },
      { ...correlation, operation: "correction.save", status: "failed", reason: "storage" },
    ]);
    privateFree(audit.records);
    expect(JSON.stringify(audit.records)).not.toContain("C:/private/path");
    expect(JSON.stringify(audit.records)).not.toContain("private abort reason");
    expect(store.corrections()).toEqual([]);
  });

  it("signale l'échec d'un snapshot mais évite les événements de réussite répétitifs", async () => {
    const { home, service, events } = await start();
    await service.snapshot(correlation);
    rmSync(join(home, "memory", "USER.md"));
    expect(() => service.snapshot(correlation)).toThrow();
    expect(events().filter((e) => e.operation === "snapshot")).toMatchObject([
      { ...correlation, status: "failed", reason: "storage" },
    ]);
    privateFree(events());
    expect(JSON.stringify(events())).not.toContain(home);
  });

  it("un journal défaillant n'empêche pas une écriture durable", () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const store = correctionStore(db, () => { throw new Error("audit indisponible"); });
    const row = store.saveCorrection(correction);
    expect(store.corrections()).toEqual([row]);
    expect(store.forgetCorrection(row.id)).toBe(true);
  });

  it("ne déclare jamais une écriture durable quand la transaction échoue", () => {
    const db = new DatabaseSync(":memory:"); dbs.push(db);
    const audit = new MemoryAudit();
    const store = correctionStore(db, (event) => audit.write({ kind: "memory.store", ...event }));
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw new Error("private commit failure");
      return exec(sql);
    });
    expect(() => store.saveCorrection(correction, correlation)).toThrow("private commit failure");
    expect(audit.records).toMatchObject([{ ...correlation, operation: "correction.save", status: "failed", reason: "storage" }]);
    expect(JSON.stringify(audit.records)).not.toContain("private commit failure");
    spy.mockRestore();
    expect(store.corrections()).toEqual([]);
  });

  it("journalise une écriture Markdown avec uniquement le nom de fichier fixe", async () => {
    const { k, events } = await start();
    await k.applyConfig({ approvals: { write: "always" }, plugins: [{ id: "memory-local", plugin: "memory" }] });
    const result = await k.tools.call("remember", { file: "notes", action: "add", text: "private history" }, correlation);
    expect(result.status).toBe("done");
    expect(events().filter((e) => e.operation === "markdown.edit")).toMatchObject([
      { ...correlation, callId: expect.any(String), status: "done", count: 1, file: "MEMORY.md" },
    ]);
    expect(events().find((e) => e.operation === "markdown.edit")!.callId).toBe(k.audit.tail(1)[0]!.callId);
    privateFree(events());
  });
});
