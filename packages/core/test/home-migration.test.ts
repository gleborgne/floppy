// Le moteur de migration du répertoire de travail : marqueur, sauvegardes, idempotence, pannes sans danger.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

  it("les rangs peuvent avoir des trous : l'ordre suit la version, pas la position dans la liste, et un rang inséré plus tard tourne seul", () => {
    const order: string[] = [];
    const mk = (id: string, version: number): MigrationStep => ({ id, version, label: id, run() { order.push(id); } });
    runHomeMigrations(home, [mk("c", 20), mk("a", 1), mk("b", 10)]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(readMigrationMarker(home).version).toBe(20);
    order.length = 0;
    // Un rang qui s'intercale (3, entre 1 et 10) tourne une fois ; les autres ne rejouent pas.
    runHomeMigrations(home, [mk("c", 20), mk("a", 1), mk("late", 3), mk("b", 10)]);
    expect(order).toEqual(["late"]);
    expect(readMigrationMarker(home).version).toBe(20);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Renommer un fichier ou un dossier, retoucher une base SQLite, créer un fichier JSON absent.
// ---------------------------------------------------------------------------------------------------------------

const step = (id: string, run: MigrationStep["run"], version = 1): MigrationStep => ({ id, version, label: id, run });
const exists = (rel: string) => existsSync(join(home, rel));

describe("moteur : renommer un fichier ou un dossier", () => {
  const mv = step("mv", (env) => { env.renamePath("old.txt", "new.txt"); env.renamePath("olddir", "newdir"); });

  it("fichier : copié à la nouvelle place, l'original mis de côté en .bak-<étape> ; dossier : déplacé d'un bloc, sans copie", () => {
    write("old.txt", "contenu");
    write("olddir/a.txt", "a");
    write("olddir/sub/b.txt", "b");
    const [r] = runHomeMigrations(home, [mv]);
    expect(r!.changes).toEqual([{ file: "old.txt", keys: [], renamedTo: "new.txt" }, { file: "olddir", keys: [], renamedTo: "newdir" }]);
    expect(exists("old.txt")).toBe(false);
    expect(read("new.txt")).toBe("contenu");
    expect(read("old.txt.bak-mv")).toBe("contenu");
    expect(exists("olddir")).toBe(false);
    expect(read("newdir/a.txt")).toBe("a");
    expect(read("newdir/sub/b.txt")).toBe("b");
    expect(exists("olddir.bak-mv")).toBe(false);
  });

  it("deuxième passage (marqueur) et rejeu forcé sur le nouveau format : sans effet", () => {
    write("old.txt", "contenu");
    write("olddir/a.txt", "a");
    runHomeMigrations(home, [mv]);
    expect(runHomeMigrations(home, [mv])[0]!.alreadyApplied).toBe(true);
    const forced = runHomeMigrations(home, [mv], { force: true })[0]!;
    expect(forced.changes).toEqual([]);
    expect(forced.skipped).toEqual([]);
    expect(read("new.txt")).toBe("contenu");
  });

  it("la nouvelle place existe déjà : conflit signalé, rien n'est écrasé, les deux sont gardés, l'étape n'échoue pas", () => {
    write("old.txt", "ancien");
    write("new.txt", "neuf");
    write("olddir/a.txt", "a");
    write("newdir/z.txt", "z");
    const [r] = runHomeMigrations(home, [mv]);
    expect(r!.error).toBeUndefined();
    expect(r!.changes).toEqual([]);
    expect(r!.skipped).toEqual([{ file: "old.txt", why: "exists" }, { file: "olddir", why: "exists" }]);
    expect(read("old.txt")).toBe("ancien");
    expect(read("new.txt")).toBe("neuf");
    expect(read("olddir/a.txt")).toBe("a");
    expect(read("newdir/z.txt")).toBe("z");
    expect(exists("old.txt.bak-mv")).toBe(false);
    expect(readMigrationMarker(home).applied.mv).toBeDefined();
  });

  it("à blanc : dit ce qui serait renommé, ne bouge rien, n'écrit pas le marqueur", () => {
    write("old.txt", "contenu");
    write("olddir/a.txt", "a");
    const [r] = runHomeMigrations(home, [mv], { dryRun: true });
    expect(r!.changes).toEqual([{ file: "old.txt", keys: [], renamedTo: "new.txt" }, { file: "olddir", keys: [], renamedTo: "newdir" }]);
    expect(exists("new.txt")).toBe(false);
    expect(exists("newdir")).toBe(false);
    expect(read("old.txt")).toBe("contenu");
    expect(exists(MIGRATION_MARKER)).toBe(false);
  });

  it("une sauvegarde déjà là (essai interrompu) garde l'original : le fichier est quand même rangé à sa nouvelle place", () => {
    write("old.txt", "contenu");
    write("old.txt.bak-mv", "contenu");
    runHomeMigrations(home, [mv]);
    expect(read("new.txt")).toBe("contenu");
    expect(exists("old.txt")).toBe(false);
    expect(read("old.txt.bak-mv")).toBe("contenu");
  });

  it("une place qui n'existe pas : rien", () => {
    expect(runHomeMigrations(home, [mv])[0]).toMatchObject({ changes: [], skipped: [] });
  });
});

describe("moteur : fichier JSON absent (create)", () => {
  const make = step("make", (env) => env.editJson("items/x.json", (d) => { d.disabled = ["a"]; return ["disabled"]; }, { create: true }));
  const plain = step("plain", (env) => env.editJson("items/y.json", (d) => { d.disabled = ["a"]; return ["disabled"]; }));

  it("créé seulement avec create, sans sauvegarde ; à blanc n'écrit rien", () => {
    expect(runHomeMigrations(home, [plain])[0]!.changes).toEqual([]);
    expect(exists("items/y.json")).toBe(false);
    const dry = runHomeMigrations(home, [make], { dryRun: true })[0]!;
    expect(dry.changes).toEqual([{ file: "items/x.json", keys: ["disabled"] }]);
    expect(exists("items/x.json")).toBe(false);
    runHomeMigrations(home, [make]);
    expect(JSON.parse(read("items/x.json"))).toEqual({ disabled: ["a"] });
    expect(exists("items/x.json.bak-make")).toBe(false);
  });
});

describe("moteur : base SQLite", () => {
  /** Une base à l'ancien format, avec des lignes. */
  function oldDb(rel: string): void {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    const db = new DatabaseSync(join(home, rel));
    db.exec("CREATE TABLE vus (url TEXT PRIMARY KEY, titre TEXT, vu_le TEXT); INSERT INTO vus VALUES ('https://a.test', 'Un', '2026-11-01'), ('https://b.test', 'Deux', '2026-11-02');");
    db.exec("CREATE TABLE digest (numero INTEGER PRIMARY KEY, titre TEXT); INSERT INTO digest VALUES (1, 'Un');");
    db.close();
  }
  const schema = (rel: string) => {
    const db = new DatabaseSync(join(home, rel), { readOnly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      return Object.fromEntries(tables.map((t) => [t, (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)]));
    } finally { db.close(); }
  };
  const sql = step("sql", (env) => env.editSqlite("data.db", (db) => {
    db.renameTable("vus", "seen");
    db.renameColumn("seen", "titre", "title");
    db.renameColumn("seen", "vu_le", "seen_at");
    db.renameColumn("digest", "numero", "number");
  }));

  it("tables et colonnes renommées, lignes gardées, copie de l'original à côté, noms seulement dans le rapport", () => {
    oldDb("data.db");
    const [r] = runHomeMigrations(home, [sql]);
    expect(r!.changes).toEqual([{ file: "data.db", keys: ["vus → seen", "seen.titre → title", "seen.vu_le → seen_at", "digest.numero → number"] }]);
    expect(schema("data.db")).toEqual({ digest: ["number", "titre"], seen: ["url", "title", "seen_at"] });
    const db = new DatabaseSync(join(home, "data.db"), { readOnly: true });
    expect(db.prepare("SELECT url, title, seen_at FROM seen ORDER BY url").all().map((x) => ({ ...x }))).toEqual([
      { url: "https://a.test", title: "Un", seen_at: "2026-11-01" }, { url: "https://b.test", title: "Deux", seen_at: "2026-11-02" }]);
    db.close();
    // La copie garde l'ancien format.
    expect(schema("data.db.bak-sql")).toEqual({ digest: ["numero", "titre"], vus: ["url", "titre", "vu_le"] });
  });

  it("idempotent : rejeu forcé, base déjà au nouveau format, base absente : intacts, sans nouvelle sauvegarde", () => {
    oldDb("data.db");
    runHomeMigrations(home, [sql]);
    rmSync(join(home, "data.db.bak-sql"));
    const forced = runHomeMigrations(home, [sql], { force: true })[0]!;
    expect(forced.changes).toEqual([]);
    expect(exists("data.db.bak-sql")).toBe(false);
    rmSync(join(home, "data.db"));
    expect(runHomeMigrations(home, [sql], { force: true })[0]).toMatchObject({ changes: [], skipped: [] });
    expect(exists("data.db")).toBe(false);
  });

  it("à blanc : dit ce qui changerait (même un renommage de colonne après un renommage de table), ne touche à rien", () => {
    oldDb("data.db");
    const before = readFileSync(join(home, "data.db"));
    const [r] = runHomeMigrations(home, [sql], { dryRun: true });
    expect(r!.changes[0]!.keys).toEqual(["vus → seen", "seen.titre → title", "seen.vu_le → seen_at", "digest.numero → number"]);
    expect(readFileSync(join(home, "data.db")).equals(before)).toBe(true);
    expect(exists("data.db.bak-sql")).toBe(false);
    expect(exists(MIGRATION_MARKER)).toBe(false);
  });

  it("les deux noms présents : conflit signalé, la base n'est pas changée à cet endroit", () => {
    oldDb("data.db");
    const db = new DatabaseSync(join(home, "data.db"));
    db.exec("CREATE TABLE seen (url TEXT)");
    db.close();
    const [r] = runHomeMigrations(home, [sql]);
    expect(r!.conflicts).toEqual([{ file: "data.db", key: "vus → seen", kept: "both" }]);
    expect(schema("data.db").vus).toEqual(["url", "titre", "vu_le"]);
    expect(schema("data.db").digest).toEqual(["number", "titre"]);
  });

  it("base verrouillée : l'étape échoue (signalée, pas dans le marqueur), la base est intacte ; libérée, le passage suivant réussit", () => {
    oldDb("data.db");
    const holder = new DatabaseSync(join(home, "data.db"));
    holder.exec("BEGIN EXCLUSIVE");
    const logs: string[] = [];
    const first = runHomeMigrations(home, [sql], { log: (l, m) => logs.push(`${l}:${m}`) });
    holder.exec("ROLLBACK");
    holder.close();
    expect(first[0]!.error).toMatch(/data\.db/);
    expect(readMigrationMarker(home).applied.sql).toBeUndefined();
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("sera retentée"))).toBe(true);
    expect(schema("data.db")).toEqual({ digest: ["numero", "titre"], vus: ["url", "titre", "vu_le"] });
    const second = runHomeMigrations(home, [sql]);
    expect(second[0]!.error).toBeUndefined();
    expect(schema("data.db").seen).toEqual(["url", "title", "seen_at"]);
  });

  it("fichier qui n'est pas une base : l'étape échoue, le fichier est intact, les étapes suivantes tournent quand même", () => {
    write("data.db", "ceci n'est pas une base SQLite, loin de là, il faut bien plus de seize octets pour que le test soit honnête");
    const later = step("later", (env) => env.editJson("o.json", (d) => { d.ok = true; return ["ok"]; }, { create: true }), 2);
    const r = runHomeMigrations(home, [sql, later]);
    expect(r[0]!.error).toBeDefined();
    expect(r[1]!.error).toBeUndefined();
    expect(read("data.db")).toMatch(/^ceci n'est pas/);
    expect(JSON.parse(read("o.json"))).toEqual({ ok: true });
  });

  it("un nom SQL douteux est refusé (l'étape échoue, rien n'est exécuté)", () => {
    oldDb("data.db");
    const bad = step("bad", (env) => env.editSqlite("data.db", (db) => db.renameColumn("vus", "titre", 'b"; DROP TABLE vus; --')));
    expect(runHomeMigrations(home, [bad])[0]!.error).toMatch(/nom SQL refusé|data\.db/);
    expect(schema("data.db").vus).toEqual(["url", "titre", "vu_le"]);
  });
});
