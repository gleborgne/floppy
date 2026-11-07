// Règle d'architecture : un plugin ne parle aux autres que par les contrats du noyau (@floppy/core).
// Il n'importe jamais un autre paquet de plugin, ni par son nom, ni par un chemin relatif, pas même pour un type.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS = join(ROOT, "plugins");

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(n)) out.push(p);
  }
  return out;
}

/** Spécificateurs d'import / export-from / import() d'un fichier. */
function specifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/** Dossier du plugin (plugins/<famille>/<id>) qui contient ce fichier. */
function pluginDir(file: string): string {
  const parts = relative(PLUGINS, file).split(sep);
  return join(PLUGINS, parts[0]!, parts[1]!);
}

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + sep);

describe("frontières entre plugins", () => {
  it("aucun plugin n'importe un autre plugin (src/)", () => {
    const bad: string[] = [];
    for (const f of walk(PLUGINS, /\.(ts|js|mjs)$/).filter((f) => relative(PLUGINS, f).split(sep)[2] === "src")) {
      const own = pluginDir(f);
      for (const s of specifiers(f)) {
        if (s.startsWith("@floppy/plugin-")) bad.push(`${relative(ROOT, f)} → ${s}`);
        else if (s.startsWith(".") && !inside(own, resolve(dirname(f), s))) bad.push(`${relative(ROOT, f)} → ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("un plugin lance ses programmes par ctx.spawn / ctx.exec, jamais par node:child_process (src/)", () => {
    // ctx vérifie permissions.exec, ferme le programme avec le plugin et le note pour l'arrêt forcé.
    // Un import de type seulement (`import type { ChildProcess }`) est permis.
    const bad: string[] = [];
    const valueImport = /^[ \t]*(?:import|export)[ \t]+(?!type\b)[^;]*?\bfrom[ \t]*["'](?:node:)?child_process["']/m;
    // Chargement à l'exécution (`await import(…)`, `require(…)`) ; `import("node:child_process").ChildProcess` est un type.
    const dynamic = /\b(?:await\s+import|require)\s*\(\s*["'](?:node:)?child_process["']/;
    for (const f of walk(PLUGINS, /\.(ts|js|mjs)$/).filter((f) => relative(PLUGINS, f).split(sep)[2] === "src")) {
      const src = readFileSync(f, "utf8");
      if (valueImport.test(src) || dynamic.test(src)) bad.push(relative(ROOT, f));
    }
    expect(bad).toEqual([]);
  });

  it("l'app de bureau n'importe pas les plugins par chemin relatif (hors assemblage)", () => {
    const EXEMPT = new Set([join(ROOT, "apps", "desktop", "src", "kernel.ts")]);
    const bad: string[] = [];
    for (const f of walk(join(ROOT, "apps", "desktop", "src"), /\.(ts|js|mjs|html)$/)) {
      if (EXEMPT.has(f)) continue;
      for (const s of specifiers(f)) {
        if (s.startsWith(".") && inside(PLUGINS, resolve(dirname(f), s))) bad.push(`${relative(ROOT, f)} → ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
