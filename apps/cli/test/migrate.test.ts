// `floppy migrate` (à blanc / --apply) et la migration au démarrage : un échec ne bloque pas le noyau.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationMarker, type MigrationStep } from "@floppy/core";
import { boot, type Running } from "../src/boot.ts";
import { HOME_MIGRATIONS } from "@floppy/setup";
import { migrateCommand } from "../src/migrate.ts";

const say = (fr: string, _en: string) => fr;
const sayEn = (_fr: string, en: string) => en;
const OLD_DOC = '---\ntitre: "Veille du jour"\ndate: 2026-11-06T08:00:00.000Z\n---\n\nsecret-body\n';

let home: string;
const running: Running[] = [];
const prevHome = process.env.FLOPPY_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "floppy-migrate-")); mkdirSync(join(home, "documents")); });
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  if (prevHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("floppy migrate", () => {
  it("à blanc par défaut : liste fichiers et clés (jamais de valeurs), n'écrit rien", () => {
    writeFileSync(join(home, "documents", "a.md"), OLD_DOC);
    writeFileSync(join(home, "onboarding.json"), JSON.stringify({ done: false, level: "hybride" }));
    const r = migrateCommand(home, {}, say);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([
      `Mise à niveau des données (à blanc : rien n'est écrit) — dossier : ${home}`,
      "[documents-title] documents : la clé d'en-tête « titre » devient « title » — 1 fichier(s) à modifier",
      "  documents/a.md : titre",
      "[onboarding-level] premier lancement : les niveaux « texte / voix / hybride » deviennent « text / voice / hybrid » — 1 fichier(s) à modifier",
      "  onboarding.json : level",
      "[onboarding-selection] premier lancement : les niveaux (`level`, `brain`) laissent place au choix par rôle (`selection`) — 1 fichier(s) à modifier",
      "  onboarding.json : level",
      ...["settings-keys", "settings-values", "config-yaml", "items-fields", "inbox-trust", "watch-preferences"].map((id) => `[${id}] rien à changer`),
      "Rien n'a été modifié. Pour appliquer (après une sauvegarde du dossier) : floppy migrate --apply",
    ]);
    expect(r.lines.join("\n")).not.toMatch(/hybride"|secret-body|Veille du jour/);
    expect(readFileSync(join(home, "documents", "a.md"), "utf8")).toBe(OLD_DOC);
    expect(existsSync(join(home, "migrations.json"))).toBe(false);
  });

  it("--apply : convertit, sauvegarde, note le marqueur ; le passage suivant dit « déjà faite »", () => {
    writeFileSync(join(home, "documents", "a.md"), OLD_DOC);
    const r = migrateCommand(home, { apply: true }, sayEn);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe("Done: 1 file(s) changed. Originals are kept next to them (*.bak-<step>).");
    expect(readFileSync(join(home, "documents", "a.md"), "utf8")).toBe(OLD_DOC.replace("titre:", "title:"));
    expect(readFileSync(join(home, "documents", "a.md.bak-documents-title"), "utf8")).toBe(OLD_DOC);
    expect(Object.keys(readMigrationMarker(home).applied)).toEqual(HOME_MIGRATIONS.map((s) => s.id));
    const again = migrateCommand(home, {}, say);
    expect(again.lines.slice(1, 4)).toEqual(["[documents-title] déjà faite", "[onboarding-level] déjà faite", "[onboarding-selection] déjà faite"]);
    expect(again.lines.at(-1)).toBe("Rien à faire.");
  });

  it("réglages et configuration : à blanc, les noms des clés (jamais les valeurs, jamais les identifiants choisis) et les conflits ; --apply écrit, floppy.yml garde ses commentaires", () => {
    const yml = "# mes notes\nplugins:\n  - id: sx\n    plugin: searxng\n    config:\n      langue: fr   # ma langue\n";
    writeFileSync(join(home, "floppy.yml"), yml);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ ton: "ancien tres secret", tone: "nouveau", demarrage_windows: true, cerveau: "x" }));
    const dry = migrateCommand(home, {}, say);
    expect(dry.lines).toContain("  settings.json : ton, demarrage_windows, cerveau");
    expect(dry.lines).toContain("  settings.json : ton (les deux noms sont présents : le nouveau est gardé)");
    expect(dry.lines).toContain("  floppy.yml : plugins[plugin=searxng].config.langue");
    expect(dry.lines.join("\n")).not.toMatch(/secret|nouveau"|ma langue/);
    expect(readFileSync(join(home, "floppy.yml"), "utf8")).toBe(yml);
    const done = migrateCommand(home, { apply: true }, sayEn);
    expect(done.code).toBe(0);
    expect(readFileSync(join(home, "floppy.yml"), "utf8")).toBe(yml.replace("langue: fr", "language: fr"));
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ tone: "nouveau", autostart: true });
    expect(done.lines).toContain("  settings.json : ton (both names are present: the new one is kept)");
  });

  it("un fichier illisible est cité, laissé tel quel", () => {
    writeFileSync(join(home, "onboarding.json"), "{ abîmé");
    const r = migrateCommand(home, {}, say);
    expect(r.lines).toContain("  onboarding.json : illisible, laissé tel quel");
    expect(readFileSync(join(home, "onboarding.json"), "utf8")).toBe("{ abîmé");
  });
});

describe("migration au démarrage", () => {
  it("convertit avant le démarrage du noyau ; une étape en panne ne le bloque pas et sera retentée", async () => {
    writeFileSync(join(home, "documents", "a.md"), OLD_DOC);
    process.env.FLOPPY_HOME = home;
    writeFileSync(join(home, "floppy.yml"), "plugins: []\n");
    const broken: MigrationStep = { id: "broken", version: 9, label: "panne", run() { throw new Error("boom"); } };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
    let r: Running;
    try {
      const { HOME_MIGRATIONS } = await import("@floppy/setup");
      r = await boot({ configPath: join(home, "floppy.yml"), plugins: [], watch: false, logger: () => {}, migrations: [...HOME_MIGRATIONS, broken], reapOrphans: false });
    } finally { console.warn = warn; }
    running.push(r);
    expect(r.kernel.status()).toEqual([]);
    expect(readFileSync(join(home, "documents", "a.md"), "utf8")).toContain("title: ");
    expect(Object.keys(readMigrationMarker(home).applied)).not.toContain("broken");
    expect(warnings.some((w) => w.includes("[migration]") && w.includes("broken") && w.includes("boom"))).toBe(true);
  });
});
