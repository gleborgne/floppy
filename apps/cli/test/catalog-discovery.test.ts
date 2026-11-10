// Les plugins livrés se trouvent par le champ `floppy` de leur package.json : plus de liste à tenir à la main.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackages, readPluginField, shippedPackages } from "../src/catalog.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Tous les paquets de plugins du dépôt (plugins/<famille>/<nom>/package.json). */
function workspacePlugins(): { name: string; floppy: unknown }[] {
  const out: { name: string; floppy: unknown }[] = [];
  for (const fam of readdirSync(join(root, "plugins"))) {
    for (const n of readdirSync(join(root, "plugins", fam))) {
      try { const j = JSON.parse(readFileSync(join(root, "plugins", fam, n, "package.json"), "utf8")); out.push({ name: j.name, floppy: j.floppy }); } catch { /* pas un paquet */ }
    }
  }
  return out;
}

describe("découverte des plugins livrés", () => {
  it("tout paquet de plugins/*/* est un plugin livré (champ floppy) et il est trouvé", () => {
    const ws = workspacePlugins();
    expect(ws.length).toBeGreaterThan(40);
    expect(ws.filter((p) => !p.floppy).map((p) => p.name), "paquets sans champ floppy").toEqual([]);
    const { packages, failed } = discoverPackages();
    expect(failed).toEqual([]);
    expect(packages.map((p) => p.name).sort()).toEqual(ws.map((p) => p.name).sort());
  });

  it("les plugins de développement ne sont livrés qu'avec dev (FLOPPY_DEV=1)", () => {
    expect(shippedPackages({ dev: false })).not.toContain("@floppy/plugin-bench-api");
    expect(shippedPackages({ dev: true })).toContain("@floppy/plugin-bench-api");
    expect(shippedPackages({ dev: true }).filter((n) => !shippedPackages({ dev: false }).includes(n))).toEqual(["@floppy/plugin-bench-api"]);
  });

  it("range par `order`, puis par nom ; sans `order`, après les autres", () => {
    const dir = mkdtempSync(join(tmpdir(), "floppy-scope-"));
    try {
      const add = (d: string, pkg: object) => { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, "package.json"), JSON.stringify(pkg)); };
      add("b", { name: "@floppy/b", floppy: { plugin: true, order: 20 } });
      add("a", { name: "@floppy/a", floppy: { plugin: true, order: 20 } });
      add("c", { name: "@floppy/c", floppy: { plugin: true, order: 10 } });
      add("z", { name: "@floppy/z", floppy: { plugin: true } });
      add("y", { name: "@floppy/y", floppy: { plugin: true } });
      add("lib", { name: "@floppy/lib" }); // pas un plugin
      mkdirSync(join(dir, "vide")); // pas un paquet
      add("mauvais", { name: "@floppy/mauvais", floppy: { plugin: true, ordre: 1 } });
      const r = discoverPackages(dir);
      expect(r.packages.map((p) => p.name)).toEqual(["@floppy/c", "@floppy/a", "@floppy/b", "@floppy/y", "@floppy/z"]);
      expect(r.failed).toEqual([{ pkg: "@floppy/mauvais", error: "champ floppy invalide : « ordre » inconnu" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("un dossier absent ne donne aucun plugin, sans planter", () => {
    expect(discoverPackages(join(tmpdir(), "floppy-n-existe-pas"))).toEqual({ packages: [], failed: [] });
  });

  it("valide le champ floppy", () => {
    expect(readPluginField({ name: "x" })).toBeUndefined();
    expect(readPluginField({ name: "x", floppy: { plugin: true, dev: true } })).toEqual({ name: "x", dev: true });
    expect(readPluginField({ name: "x", floppy: {} })).toMatchObject({ error: expect.stringContaining("plugin") });
    expect(readPluginField({ name: "x", floppy: { plugin: true, order: "1" } })).toMatchObject({ error: expect.stringContaining("order") });
    expect(readPluginField({ name: "x", floppy: { plugin: true, dev: "oui" } })).toMatchObject({ error: expect.stringContaining("dev") });
  });
});
