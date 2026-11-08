// La compilation des fenêtres (npm run build:ui) produit tout ce que les pages et les fenêtres chargent :
// un fichier statique oublié dans la copie, ou un import mal réécrit, se verrait ici et non au premier lancement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingUi, pageFile, preloadFile } from "../src/ui.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let out = "";
let built = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "floppy-ui-"));
  execFileSync(process.execPath, [join(desktop, "scripts", "build-ui.mjs"), "--out", out], { cwd: desktop, encoding: "utf8", timeout: 170_000 });
  built = join(out, "renderer");
}, 180_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const pages = () => readdirSync(join(desktop, "src", "renderer")).filter((f) => f.endsWith(".html"));

describe("build:ui", () => {
  it("chaque page construite trouve ses scripts et ses styles", () => {
    expect(pages().length).toBeGreaterThanOrEqual(7);
    for (const page of pages()) {
      const html = readFileSync(join(built, page), "utf8");
      const refs = [...html.matchAll(/\b(?:src|href)="([^"#]+)"/g)].map((m) => m[1]!).filter((r) => !/^(https?:|data:)/.test(r));
      expect(refs.length, page).toBeGreaterThan(0);
      for (const ref of refs) expect(existsSync(join(built, ref)), `${page} : ${ref}`).toBe(true);
    }
  });

  it("chaque import relatif d'un script construit existe (extensions réécrites en .js)", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []));
    const scripts = walk(built);
    expect(scripts.length).toBeGreaterThan(20);
    for (const file of scripts) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
        expect(m[1], file).not.toMatch(/\.ts$/);
        expect(existsSync(resolve(dirname(file), m[1]!)), `${file} : ${m[1]}`).toBe(true);
      }
    }
  });

  it("Preact est copié avec sa licence, sans fichier de types ni source TypeScript", () => {
    expect(existsSync(join(built, "vendor", "preact.mjs"))).toBe(true);
    expect(existsSync(join(built, "vendor", "preact.LICENSE"))).toBe(true);
    expect(existsSync(join(built, "vendor", "preact.d.mts"))).toBe(false);
    expect(readdirSync(built).filter((f) => f.endsWith(".ts"))).toEqual([]);
  });

  it("chaque preload source devient un fichier .cjs à la racine de build/", () => {
    const sources = readdirSync(join(desktop, "src")).filter((f) => /^preload.*\.cts$/.test(f));
    expect(sources.length).toBe(8);
    for (const s of sources) {
      const target = join(out, s.replace(/\.cts$/, ".cjs"));
      expect(existsSync(target), s).toBe(true);
      expect(readFileSync(target, "utf8")).toContain('require("electron")');
    }
  });

  it("le dossier construit est reconnu comme complet", () => {
    expect(missingUi(out)).toBeNull();
  });
});

describe("dossier des fenêtres absent", () => {
  it("dit en français de lancer npm run build:ui", () => {
    const empty = mkdtempSync(join(tmpdir(), "floppy-ui-empty-"));
    try {
      expect(missingUi(empty)).toMatch(/npm run build:ui/);
      mkdirSync(join(empty, "renderer"));
      writeFileSync(pageFile("index", empty), "");
      expect(missingUi(empty)).not.toBeNull();      // sans le preload, c'est incomplet
      writeFileSync(preloadFile("preload.cjs", empty), "");
      expect(missingUi(empty)).toBeNull();
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
