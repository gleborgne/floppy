// Le fichier d'exemple publié (copié en floppy.yml au premier lancement) doit être valide et neutre.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfigFile, manifestError } from "@floppy/core";
import { loadCatalog, shippedPackages } from "../src/catalog.ts";

// Le banc (bench/bench.yml) se lance avec FLOPPY_DEV=1 : ses plugins de développement comptent ici.
const { plugins: catalog, failed } = await loadCatalog({ dev: true });

const files = ["floppy.example.yml", "bench/bench.yml"].map((f) => fileURLToPath(new URL(`../../../${f}`, import.meta.url)));

describe("catalogue", () => {
  it("chaque paquet se charge et exporte un plugin", () => {
    expect(failed).toEqual([]);
    expect(catalog).toHaveLength(shippedPackages({ dev: true }).length);
  });

  it("le manifeste de chaque plugin livré est valide (aucun champ inconnu)", () => {
    for (const p of catalog) expect(manifestError(p.manifest), p.manifest.id).toBeUndefined();
  });

  it("la production ne contient pas les plugins de développement (bench-api répond aux accords tout seul)", async () => {
    const prod = await loadCatalog({ dev: false });
    expect(prod.plugins.some((p) => p.manifest.id === "bench-api")).toBe(false);
  });

  it("un paquet qui ne se charge pas est rendu à part, le reste se charge", async () => {
    const r = await loadCatalog({ packages: ["@floppy/plugin-memory", "@floppy/plugin-qui-n-existe-pas"] });
    expect(r.plugins.map((p) => p.manifest.id)).toEqual(["memory"]);
    expect(r.failed.map((f) => f.pkg)).toEqual(["@floppy/plugin-qui-n-existe-pas"]);
  });
});

describe.each(files)("%s", (file) => {
  it("passe le schéma du noyau et celui de chaque plugin", () => {
    const cfg = loadConfigFile(file);
    for (const entry of cfg.plugins) {
      const def = catalog.find((p) => p.manifest.id === entry.plugin);
      expect(def, `plugin inconnu : ${entry.plugin}`).toBeDefined();
      const r = def!.config?.safeParse(entry.config ?? {});
      expect(r?.success ?? true, `${entry.id} : ${JSON.stringify(r?.error?.issues)}`).toBe(true);
    }
  });

  it("ne garde que des clés connues : un ancien nom de clé ne passe pas inaperçu (les schémas des plugins ignorent les clés inconnues)", () => {
    const cfg = loadConfigFile(file);
    for (const entry of cfg.plugins) {
      const schema = catalog.find((p) => p.manifest.id === entry.plugin)?.config as { strict?: () => { safeParse(x: unknown): { success: boolean; error?: { issues: unknown } } } } | undefined;
      const r = schema?.strict?.().safeParse(entry.config ?? {});
      if (file.endsWith("floppy.example.yml")) expect(r?.success ?? true, `${entry.id} : ${JSON.stringify(r?.error?.issues)}`).toBe(true);
    }
  });

  it("ne contient aucun chemin ni nom propre à un PC", () => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/[A-Z]:[\/](Users|projects|AIModels)/i);
    expect(text).not.toMatch(/\.\.\/(cascade|prototypes)/);
  });
});
