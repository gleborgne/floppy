// Le moteur de migration du répertoire de travail : marqueur, sauvegardes, idempotence, pannes sans danger.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_MARKER, readMigrationMarker, runHomeMigrations, type MigrationStep } from "../src/index.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "floppy-migration-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const read = (rel: string) => readFileSync(join(home, rel), "utf8");
const write = (rel: string, text: string) => { mkdirSync(join(home, rel, ".."), { recursive: true }); writeFileSync(join(home, rel), text); };

/** Étape d'essai : `color` → `colour` dans data.json, et `note:` → `memo:` dans notes/*.txt. */
const rename: MigrationStep = {
  id: "rename-color", version: 1, label: "essai",
  run(env) {
    env.editJson("data.json", (d) => { if (!("color" in d)) return []; d.colour = d.color; delete d.color; return ["color"]; });
    for (const f of env.list("notes", ".txt")) env.editText(f, (t) => (t.startsWith("note:") ? { text: "memo:" + t.slice(5), keys: ["note"] } : undefined));
  },
};

describe("moteur de migration", () => {
  it("ancien format → nouveau, sauvegarde à côté, marqueur écrit ; le second passage ne change rien", () => {
    write("data.json", JSON.stringify({ color: "rouge", other: 1 }));
    write("notes/a.txt", "note: bonjour");
    const first = runHomeMigrations(home, [rename], { now: () => new Date("2026-11-10T08:00:00Z") });
    expect(first).toEqual([{ step: "rename-color", alreadyApplied: false, changes: [{ file: "data.json", keys: ["color"] }, { file: "notes/a.txt", keys: ["note"] }], skipped: [] }]);
    expect(JSON.parse(read("data.json"))).toEqual({ colour: "rouge", other: 1 });
    expect(read("notes/a.txt")).toBe("memo: bonjour");
    // Sauvegardes : l'original, à côté.
    expect(JSON.parse(read("data.json.bak-rename-color"))).toEqual({ color: "rouge", other: 1 });
    expect(read("notes/a.txt.bak-rename-color")).toBe("note: bonjour");
    expect(readMigrationMarker(home)).toEqual({ version: 1, applied: { "rename-color": "2026-11-10T08:00:00.000Z" } });

    const second = runHomeMigrations(home, [rename]);
    expect(second).toEqual([{ step: "rename-color", alreadyApplied: true, changes: [], skipped: [] }]);
  });

  it("idempotente sans marqueur : un fichier déjà au nouveau format n'est ni réécrit ni sauvegardé", () => {
    write("data.json", JSON.stringify({ colour: "rouge" }));
    write("notes/a.txt", "memo: déjà");
    const r = runHomeMigrations(home, [rename], { force: true });
    expect(r[0]!.changes).toEqual([]);
    expect(existsSync(join(home, "data.json.bak-rename-color"))).toBe(false);
    expect(existsSync(join(home, "notes/a.txt.bak-rename-color"))).toBe(false);
  });

  it("fichiers et dossiers absents : rien à faire, l'étape est notée faite", () => {
    const r = runHomeMigrations(home, [rename]);
    expect(r[0]).toMatchObject({ alreadyApplied: false, changes: [], skipped: [] });
    expect(readMigrationMarker(home).applied["rename-color"]).toBeTruthy();
  });

  it("fichier JSON abîmé : laissé tel quel (ni déplacé, ni réécrit), signalé", () => {
    write("data.json", "{ pas du json");
    const r = runHomeMigrations(home, [rename]);
    expect(r[0]!.skipped).toEqual([{ file: "data.json", why: "unreadable" }]);
    expect(read("data.json")).toBe("{ pas du json");
    expect(existsSync(join(home, "data.json.bak-rename-color"))).toBe(false);
    expect(existsSync(join(home, "data.json.corrupt"))).toBe(false);
  });

  it("à blanc : rapporte les noms de clés, n'écrit rien (ni fichier, ni sauvegarde, ni marqueur)", () => {
    write("data.json", JSON.stringify({ color: "rouge" }));
    const r = runHomeMigrations(home, [rename], { dryRun: true });
    expect(r[0]!.changes).toEqual([{ file: "data.json", keys: ["color"] }]);
    expect(JSON.parse(read("data.json"))).toEqual({ color: "rouge" });
    expect(existsSync(join(home, "data.json.bak-rename-color"))).toBe(false);
    expect(existsSync(join(home, MIGRATION_MARKER))).toBe(false);
    expect(JSON.stringify(r)).not.toContain("rouge");
  });

  it("la sauvegarde garde l'original : elle n'est jamais écrasée par un rejeu", () => {
    write("data.json", JSON.stringify({ color: "rouge" }));
    runHomeMigrations(home, [rename]);
    // Restauration manuelle d'un ancien fichier, puis rejeu forcé.
    write("data.json", JSON.stringify({ color: "bleu" }));
    runHomeMigrations(home, [rename], { force: true });
    expect(JSON.parse(read("data.json"))).toEqual({ colour: "bleu" });
    expect(JSON.parse(read("data.json.bak-rename-color"))).toEqual({ color: "rouge" });
  });

  it("les versions peuvent avoir des trous : l'ordre suit la version, le marqueur garde la plus haute", () => {
    const seen: string[] = [];
    const at = (id: string, version: number): MigrationStep => ({ id, version, label: id, run() { seen.push(id); } });
    runHomeMigrations(home, [at("c", 15), at("a", 3), at("b", 10)]);
    expect(seen).toEqual(["a", "b", "c"]);
    expect(readMigrationMarker(home).version).toBe(15);
  });

  it("une étape qui échoue ne lève pas, n'entre pas dans le marqueur et repart au passage suivant ; les autres tournent", () => {
    const logs: string[] = [];
    let broken = true;
    const flaky: MigrationStep = { id: "flaky", version: 1, label: "panne", run() { if (broken) throw new Error("disque plein"); } };
    const later: MigrationStep = { id: "later", version: 2, label: "suite", run(env) { env.editJson("data.json", (d) => { d.done = true; return ["done"]; }); } };
    write("data.json", "{}");
    const first = runHomeMigrations(home, [later, flaky], { log: (l, m) => logs.push(`${l}: ${m}`) });
    expect(first.map((r) => [r.step, r.error ?? null])).toEqual([["flaky", "disque plein"], ["later", null]]);
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("flaky") && l.includes("disque plein"))).toBe(true);
    expect(Object.keys(readMigrationMarker(home).applied)).toEqual(["later"]);
    broken = false;
    const second = runHomeMigrations(home, [flaky, later]);
    expect(second.map((r) => [r.step, r.alreadyApplied, r.error ?? null])).toEqual([["flaky", false, null], ["later", true, null]]);
    expect(Object.keys(readMigrationMarker(home).applied).sort()).toEqual(["flaky", "later"]);
  });

  it("conflit : le nom de la clé est rapporté (jamais la valeur), une seule fois, et le fichier est quand même mis à niveau ; read : lecture seule", () => {
    const logs: string[] = [];
    const both: MigrationStep = {
      id: "both", version: 1, label: "deux noms",
      run(env) {
        expect(env.read("data.json")).toContain("secret");
        env.editJson("data.json", (d) => { env.conflict("data.json", "color"); env.conflict("data.json", "color"); delete d.color; return ["color"]; });
        expect(env.read("absent.json")).toBeUndefined();
      },
    };
    write("data.json", JSON.stringify({ color: "secret", colour: "x" }));
    const r = runHomeMigrations(home, [both], { log: (l, m) => logs.push(`${l}: ${m}`) });
    expect(r[0]!.conflicts).toEqual([{ file: "data.json", key: "color" }]);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.parse(read("data.json"))).toEqual({ colour: "x" });
    expect(logs.filter((l) => l.startsWith("warn:") && l.includes("color"))).toHaveLength(1);
  });

  it("marqueur abîmé : les étapes (idempotentes) sont rejouées et le marqueur réécrit", () => {
    write(MIGRATION_MARKER, "pas du json");
    write("data.json", JSON.stringify({ colour: "x" }));
    const r = runHomeMigrations(home, [rename]);
    expect(r[0]!.alreadyApplied).toBe(false);
    expect(readMigrationMarker(home).version).toBe(1);
  });
});
