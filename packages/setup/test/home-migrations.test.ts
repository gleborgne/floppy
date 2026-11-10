// Les étapes de migration livrées : en-tête des documents (`titre` → `title`) et niveau du premier lancement.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationMarker, runHomeMigrations } from "@floppy/core";
import { HOME_MIGRATIONS, migrateHome } from "../src/index.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "floppy-home-migrations-")); mkdirSync(join(home, "documents")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const read = (rel: string) => readFileSync(join(home, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(home, rel), text);

/** Passe les étapes jusqu'à celle-là incluse (les suivantes ne touchent pas encore au fichier). */
const only = (id: string) => runHomeMigrations(home, HOME_MIGRATIONS.slice(0, HOME_MIGRATIONS.findIndex((x) => x.id === id) + 1));

const OLD_DOC = '---\ntitre: "Veille du jour"\ndate: 2026-11-06T08:00:00.000Z\nsource: "veille"\ntags: ["veille"]\n---\n\n# Corps\n\ntitre: ceci est du texte, pas l\'en-tête\n';

describe("étape documents-title", () => {
  it("renomme la clé d'en-tête `titre`, garde le reste octet pour octet, sauvegarde l'original", () => {
    write("documents/2026-11-06-0800-veille.md", OLD_DOC);
    const r = migrateHome(home);
    expect(r.find((x) => x.step === "documents-title")!.changes).toEqual([{ file: "documents/2026-11-06-0800-veille.md", keys: ["titre"] }]);
    expect(read("documents/2026-11-06-0800-veille.md")).toBe(OLD_DOC.replace('---\ntitre:', '---\ntitle:'));
    expect(read("documents/2026-11-06-0800-veille.md.bak-documents-title")).toBe(OLD_DOC);
    // La sauvegarde ne finit pas par .md : le plugin des documents ne la liste pas.
    expect("documents/2026-11-06-0800-veille.md.bak-documents-title".endsWith(".md")).toBe(false);
  });

  it("garde les fins de ligne CRLF", () => {
    write("documents/a.md", '---\r\ntitre: "A"\r\ndate: 2026-11-06T08:00:00.000Z\r\n---\r\n\r\ncorps\r\n');
    migrateHome(home);
    expect(read("documents/a.md")).toBe('---\r\ntitle: "A"\r\ndate: 2026-11-06T08:00:00.000Z\r\n---\r\n\r\ncorps\r\n');
  });

  it("deuxième passage : sans effet (marqueur), et sans marqueur (rejeu forcé) : fichier déjà converti intact", () => {
    write("documents/a.md", OLD_DOC);
    migrateHome(home);
    const once = read("documents/a.md");
    expect(migrateHome(home).every((r) => r.alreadyApplied)).toBe(true);
    const forced = migrateHome(home, { force: true });
    expect(forced.find((x) => x.step === "documents-title")!.changes).toEqual([]);
    expect(read("documents/a.md")).toBe(once);
  });

  it("fichier déjà au nouveau format, sans en-tête, ou avec les deux clés : laissé tel quel", () => {
    const fresh = '---\ntitle: "Déjà"\ndate: 2026-11-06T08:00:00.000Z\n---\n\ncorps\n';
    const plain = "# Sans en-tête\n\ntitre: texte\n";
    const both = '---\ntitre: "Ancien"\ntitle: "Nouveau"\n---\n\ncorps\n';
    write("documents/fresh.md", fresh); write("documents/plain.md", plain); write("documents/both.md", both);
    const r = migrateHome(home).find((x) => x.step === "documents-title")!;
    expect(r.changes).toEqual([]);
    expect(r.skipped).toEqual([{ file: "documents/both.md", why: "conflict" }]);
    expect([read("documents/fresh.md"), read("documents/plain.md"), read("documents/both.md")]).toEqual([fresh, plain, both]);
  });

  it("dossier documents absent : rien à faire", () => {
    rmSync(join(home, "documents"), { recursive: true });
    expect(migrateHome(home).find((x) => x.step === "documents-title")).toMatchObject({ changes: [], skipped: [], alreadyApplied: false });
    expect(migrateHome(home).find((x) => x.step === "documents-title")!.error).toBeUndefined();
  });
});

describe("étape onboarding-level", () => {
  it("convertit les niveaux texte / voix / hybride, garde les autres clés, sauvegarde", () => {
    for (const [old, now] of [["texte", "text"], ["voix", "voice"], ["hybride", "hybrid"]] as const) {
      rmSync(join(home, "onboarding.json.bak-onboarding-level"), { force: true });
      rmSync(join(home, "migrations.json"), { force: true });
      write("onboarding.json", JSON.stringify({ done: false, level: old, brain: "claude-cli/claude" }));
      const r = only("onboarding-level").find((x) => x.step === "onboarding-level")!;
      expect(r.changes).toEqual([{ file: "onboarding.json", keys: ["level"] }]);
      expect(JSON.parse(read("onboarding.json"))).toEqual({ done: false, level: now, brain: "claude-cli/claude" });
      expect(JSON.parse(read("onboarding.json.bak-onboarding-level")).level).toBe(old);
    }
  });

  it("niveau déjà en anglais, `local`, ou absent : fichier intact ; fichier absent : rien", () => {
    for (const body of [{ done: true, level: "voice" }, { done: true, level: "local-max" }, { done: false }]) {
      rmSync(join(home, "migrations.json"), { force: true });
      write("onboarding.json", JSON.stringify(body));
      expect(only("onboarding-level").find((x) => x.step === "onboarding-level")!.changes).toEqual([]);
      expect(JSON.parse(read("onboarding.json"))).toEqual(body);
    }
    rmSync(join(home, "onboarding.json")); rmSync(join(home, "migrations.json"));
    expect(only("onboarding-level").find((x) => x.step === "onboarding-level")).toMatchObject({ changes: [], skipped: [] });
  });

  it("fichier abîmé : laissé tel quel, non déplacé", () => {
    write("onboarding.json", '{ "done": false, "level": "texte"');
    const r = only("onboarding-level").find((x) => x.step === "onboarding-level")!;
    expect(r.skipped).toEqual([{ file: "onboarding.json", why: "unreadable" }]);
    expect(read("onboarding.json")).toBe('{ "done": false, "level": "texte"');
  });
});


describe("étape onboarding-selection", () => {
  it("retire `level` et `brain`, garde le reste, sauvegarde l'original", () => {
    write("onboarding.json", JSON.stringify({ done: false, level: "local", brain: "claude-cli/claude" }));
    const r = only("onboarding-selection").find((x) => x.step === "onboarding-selection")!;
    expect(r.changes).toEqual([{ file: "onboarding.json", keys: ["level", "brain"] }]);
    expect(JSON.parse(read("onboarding.json"))).toEqual({ done: false });
    expect(JSON.parse(read("onboarding.json.bak-onboarding-selection"))).toEqual({ done: false, level: "local", brain: "claude-cli/claude" });
  });

  it("installation terminée : `done`, `at` et `skipped` restent ; la suite des étapes mène un ancien `texte` jusqu'à la fin", () => {
    write("onboarding.json", JSON.stringify({ done: true, level: "texte", at: "2026-11-07T10:00:00.000Z" }));
    migrateHome(home);
    expect(JSON.parse(read("onboarding.json"))).toEqual({ done: true, at: "2026-11-07T10:00:00.000Z" });
  });

  it("déjà au nouveau format (`selection`), ou fichier absent ou abîmé : rien n'est touché", () => {
    const body = { done: false, selection: { brain: "claude/sonnet", stt: "sherpa-library/parakeet-tdt-v3-int8" } };
    write("onboarding.json", JSON.stringify(body));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")!.changes).toEqual([]);
    expect(JSON.parse(read("onboarding.json"))).toEqual(body);
    rmSync(join(home, "onboarding.json")); rmSync(join(home, "migrations.json"));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")).toMatchObject({ changes: [], skipped: [] });
    write("onboarding.json", '{ "done": false, "level": "local"');
    rmSync(join(home, "migrations.json"));
    expect(only("onboarding-selection").find((x) => x.step === "onboarding-selection")!.skipped).toEqual([{ file: "onboarding.json", why: "unreadable" }]);
    expect(read("onboarding.json")).toBe('{ "done": false, "level": "local"');
  });
});

describe("marqueur", () => {
  it("note chaque étape et la version la plus haute ; à blanc, rien n'est écrit", () => {
    write("documents/a.md", OLD_DOC);
    const dry = migrateHome(home, { dryRun: true });
    expect(dry.flatMap((r) => r.changes)).toEqual([{ file: "documents/a.md", keys: ["titre"] }]);
    expect(existsSync(join(home, "migrations.json"))).toBe(false);
    expect(read("documents/a.md")).toBe(OLD_DOC);
    migrateHome(home);
    const marker = readMigrationMarker(home);
    expect(marker.version).toBe(Math.max(...HOME_MIGRATIONS.map((s) => s.version)));
    expect(Object.keys(marker.applied).sort()).toEqual(HOME_MIGRATIONS.map((s) => s.id).sort());
  });
});
