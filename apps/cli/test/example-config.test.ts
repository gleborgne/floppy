// Le fichier d'exemple publié (copié en floppy.yml au premier lancement) doit être valide et neutre.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfigFile } from "@floppy/core";
import { catalog as production, devPlugins } from "../src/catalog.ts";

// Le banc (bench/bench.yml) se lance avec FLOPPY_DEV=1 : ses plugins de développement comptent ici.
const catalog = [...production, ...devPlugins];

const files = ["floppy.example.yml", "bench/bench.yml"].map((f) => fileURLToPath(new URL(`../../../${f}`, import.meta.url)));

describe("catalogue de production", () => {
  it("ne contient pas les plugins de développement (bench-api répond aux accords tout seul)", () => {
    if (process.env.FLOPPY_DEV === "1") return;
    for (const d of devPlugins) expect(production.some((p) => p.manifest.id === d.manifest.id)).toBe(false);
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

  it("ne contient aucun chemin ni nom propre à un PC", () => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/[A-Z]:[\/](Users|projects|AIModels)/i);
    expect(text).not.toMatch(/\.\.\/(cascade|prototypes)/);
  });
});
