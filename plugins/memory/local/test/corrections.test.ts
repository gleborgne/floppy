import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Kernel, TextError } from "@floppy/core";
import type { MemoryCorrectionInput, MemoryService } from "@floppy/contracts";
import memory from "../src/index.ts";
import { correctionStore } from "../src/corrections.ts";

const input = (): MemoryCorrectionInput => ({
  heard: "court team", canonical: "Core Team", scope: { domain: "m365.teams", account: "contoso", container: "team-1" },
  target: { kind: "channel", id: "channel-1", parentId: "team-1" },
  evidence: { text: "Non, je parle du canal Core Team.", session: "avatar" },
});
const databases: DatabaseSync[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stopAll();
  for (const db of databases.splice(0)) db.close();
});
function store() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  return { db, ...correctionStore(db) };
}

describe("corrections structurées", () => {
  it("déduplique casse/espaces et conserve la provenance initiale", () => {
    const s = store();
    const first = s.saveCorrection(input());
    const duplicate = s.saveCorrection({ ...input(), heard: "  COURT   TEAM  ", canonical: " core   team " });
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({ ...input(), version: 1 });
    expect(s.corrections({ heard: " COURT   TEAM " })).toEqual([first]);
    const copy = s.corrections()[0]!;
    copy.scope.account = "changed";
    expect(s.corrections()[0]!.scope.account).toBe("contoso");
  });

  it("sépare les homonymes par portée exacte, y compris la portée générale", () => {
    const s = store();
    const scopes = [input().scope, { ...input().scope, account: "fabrikam" }, { ...input().scope, container: "team-2" }, { domain: "m365.teams" }];
    const saved = scopes.map((scope, i) => s.saveCorrection({ ...input(), scope, canonical: `Canal ${i}` }));
    expect(s.corrections()).toHaveLength(4);
    for (let i = 0; i < scopes.length; i++) expect(s.corrections({ scope: scopes[i] })).toEqual([saved[i]]);
    expect(s.corrections({ scope: { domain: "m365.teams", account: "contoso" } })).toEqual([]);
    expect(s.corrections({ scope: { domain: "m365.mail" } })).toEqual([]);
  });

  it("exige id et version pour remplacer une contradiction sans changer la portée", () => {
    const s = store();
    const first = s.saveCorrection(input());
    const changed = { ...input(), canonical: "Platform Team", evidence: { text: "Corrige : Platform Team." } };
    expect(() => s.saveCorrection(changed)).toThrow(TextError);
    expect(() => s.saveCorrection({ ...changed, replaces: { id: first.id, version: 2 } })).toThrow(/changé/);
    const next = s.saveCorrection({ ...changed, replaces: { id: first.id, version: 1 } });
    expect(next).toMatchObject({ id: first.id, createdAt: first.createdAt, version: 2, canonical: "Platform Team", evidence: changed.evidence });
    expect(() => s.saveCorrection({ ...input(), replaces: { id: first.id, version: 1 } })).toThrow(/changé/);
    expect(() => s.saveCorrection({ ...changed, scope: { domain: "m365.teams" }, replaces: { id: next.id, version: 2 } })).toThrow(/changé/);
    expect(s.corrections()).toEqual([next]);
  });

  it("refuse aussi un changement de référence cible implicite", () => {
    const s = store(); const first = s.saveCorrection(input());
    expect(() => s.saveCorrection({ ...input(), target: { kind: "channel", id: "channel-2" } })).toThrow(/remplacement/);
    expect(s.corrections()).toEqual([first]);
  });

  it.each([
    { heard: "   " }, { heard: "x".repeat(257) }, { canonical: "Core\nTeam" }, { canonical: "Core\u202eTeam" },
    { scope: { domain: "m365.teams", account: "" } }, { scope: { domain: "m365.teams", tenant: "unexpected" } },
    { target: { kind: "channel", id: "" } }, { evidence: { text: "" } }, { evidence: { text: "x".repeat(2001) } },
    { evidence: { text: "Oui", session: "avatar\u0000" } },
  ])("rejette les données invalides sans modifier les corrections : %j", (patch) => {
    const s = store(); const first = s.saveCorrection(input());
    expect(() => s.saveCorrection({ ...input(), ...patch } as MemoryCorrectionInput)).toThrow(TextError);
    expect(s.corrections()).toEqual([first]);
  });

  it("annule un accès avant toute lecture ou mutation", () => {
    const s = store(); const first = s.saveCorrection(input()); const signal = AbortSignal.abort();
    expect(() => s.corrections({}, { signal })).toThrow();
    expect(() => s.saveCorrection({ ...input(), heard: "another" }, { signal })).toThrow();
    expect(() => s.forgetCorrection(first.id, { signal })).toThrow();
    expect(s.corrections()).toEqual([first]);
  });

  it("signale une ligne illisible sans l'effacer", () => {
    const s = store(); const first = s.saveCorrection(input());
    s.db.prepare("UPDATE memory_corrections SET data = ? WHERE id = ?").run("broken", first.id);
    expect(() => s.corrections()).toThrow(/illisible/);
    expect(s.db.prepare("SELECT data FROM memory_corrections WHERE id = ?").get(first.id)!.data).toBe("broken");
  });

  it("borne le nombre de corrections et permet encore de dédupliquer ou d'oublier", () => {
    const s = store(); const first = s.saveCorrection(input());
    const insert = s.db.prepare("INSERT INTO memory_corrections (id, scope_key, heard_key, data) VALUES (?, ?, ?, ?)");
    for (let i = 1; i < 2000; i++) {
      const row = { ...first, id: randomUUID(), heard: `heard ${i}` };
      insert.run(row.id, "scope", row.heard, JSON.stringify(row));
    }
    expect(() => s.saveCorrection({ ...input(), heard: "new" })).toThrow(/pleine/);
    expect(s.saveCorrection(input())).toEqual(first);
    expect(s.forgetCorrection(first.id)).toBe(true);
    expect(s.saveCorrection(input()).id).not.toBe(first.id);
    expect(s.corrections()).toHaveLength(2000);
  });

  it("rejette un filtre invalide et un identifiant d'oubli invalide", () => {
    const s = store(); const first = s.saveCorrection(input());
    expect(() => s.corrections({ scope: { domain: "" } })).toThrow(TextError);
    expect(() => s.forgetCorrection("not-an-id")).toThrow(TextError);
    expect(s.corrections()).toEqual([first]);
  });
});

describe("persistance du plugin mémoire", () => {
  async function start(home: string) {
    const k = new Kernel({ logger: () => {}, plugins: [memory], home }); kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "memory", plugin: "memory", config: { dir: home } }] });
    return { k, service: k.service<MemoryService>("memory")! };
  }
  it("préserve USER/MEMORY et l'historique, reprend les corrections puis oublie durablement", async () => {
    const home = mkdtempSync(join(tmpdir(), "memory-corrections-"));
    const profile = "- Profil existant\n", notes = "- Note existante\n";
    writeFileSync(join(home, "USER.md"), profile); writeFileSync(join(home, "MEMORY.md"), notes);
    const first = await start(home);
    await first.service.record({ session: "old-session", role: "user", text: "Une discussion existante sur la cafetière" });
    const correction = await first.service.saveCorrection!(input());
    await first.k.stopAll();
    const second = await start(home);
    expect(await second.service.snapshot()).toEqual({ user: profile, memory: notes });
    expect(await second.service.search("cafetière")).toMatchObject([{ session: "old-session", role: "user" }]);
    expect(await second.service.corrections!()).toEqual([correction]);
    expect(await second.service.forgetCorrection!(correction.id)).toBe(true);
    expect(await second.service.forgetCorrection!(correction.id)).toBe(false);
    await second.k.stopAll();
    const third = await start(home);
    expect(await third.service.corrections!()).toEqual([]);
    expect(await third.service.snapshot()).toEqual({ user: profile, memory: notes });
    expect(await third.service.search("cafetière")).toHaveLength(1);
  });
});
