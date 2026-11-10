// Le gabarit et les exemples du SDK passent les contrôles d'installation et démarrent dans le processus isolé.
import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlugin } from "../src/plugins/check.ts";
import { newPlugin, SDK_DIR } from "../src/plugins/scaffold.ts";
import { loadPluginDir, throwawayTest } from "../src/user-plugins.ts";

const tmp: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "floppy-sdk-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("SDK des plugins", () => {
  it.each(["timer", "weather"])("l'exemple %s passe les contrôles et démarre isolé", async (name) => {
    const dir = join(SDK_DIR, "examples", name);
    expect(checkPlugin(dir).findings.filter((f) => f.severity === "block")).toEqual([]);
    const { id, def } = await loadPluginDir(dir);
    const t = await throwawayTest(def, id);
    expect(t.error).toBeUndefined();
    expect(t.state).toBe("active");
    expect(t.tools.length).toBeGreaterThan(0);
  }, 30_000);

  it("le gabarit crée un plugin valide, qui démarre", async () => {
    const parent = temp();
    const dir = newPlugin("mon-essai", parent);
    const r = checkPlugin(dir);
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.path).sort()).toEqual([".gitignore", "AGENTS.md", "CLAUDE.md", "README.md", "floppy-plugin.d.ts", "floppy-plugin.json", "index.ts"]);
    expect(readFileSync(join(dir, "index.ts"), "utf8")).not.toContain("__");
    const t = await throwawayTest((await loadPluginDir(dir)).def, "mon-essai");
    expect(t).toMatchObject({ ok: true, tools: [{ name: "mon_essai_hello", level: "read" }], settings: [{ key: "mon_essai_polite", risk: "free" }] });
    expect(() => newPlugin("mon-essai", parent)).toThrow();
    expect(() => newPlugin("Mauvais Id", parent)).toThrow();
  }, 30_000);

  it("un plugin personnel déclare ses propres noms (augmentation de module) ; une faute de frappe ne compile pas", () => {
    const root = temp();
    const plugins = join(root, "plugins");
    mkdirSync(join(plugins, "perso"), { recursive: true });
    cpSync(join(SDK_DIR, "floppy-plugin.d.ts"), join(plugins, "floppy-plugin.d.ts"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2024", lib: ["ES2024", "DOM"], module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [] },
      include: ["plugins/**/*.ts"],
    }));
    const header = `import type { PluginContext } from "../floppy-plugin.d.ts";
declare module "../floppy-plugin.d.ts" {
  interface Services { "perso.compteur": { suivant(): number } }
  interface HookTypes { "perso.avant": { input: { n: number }; output: string } }
  interface BusEvents { "perso.tic": { fois: number } }
}
`;
    const tsc = join(fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)));
    const compile = (body: string) => {
      writeFileSync(join(plugins, "perso", "index.ts"), header + `export default { manifest: { id: "perso", version: "1", licence: "MIT", provides: ["perso.compteur"] }, apply(ctx: PluginContext) {
${body}
} };
`);
      const r = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { encoding: "utf8" });
      return r.stdout + r.stderr;
    };
    expect(compile(`
      ctx.provide("perso.compteur", { suivant: () => 1 });
      ctx.hook("perso.avant", async (input, next) => next({ n: input.n + 1 }));
      ctx.on("perso.tic", (p) => { const n: number = p.fois; void n; });
      ctx.emit("perso.tic", { fois: 1 });
      void ctx.runHook("perso.avant", { n: 1 }, async (i) => String(i.n)).then((s: string) => s);
      ctx.get("perso.compteur").suivant();`)).toBe("");
    const bad = compile(`
      ctx.get("perso.compteurr");
      ctx.hook("perso.avnt", async (input, next) => next(input));
      ctx.on("perso.tc", () => {});
      ctx.emit("initiativ", {});`);
    expect(bad.match(/error TS/g)).toHaveLength(4);
  }, 120_000);

  it("un exemple modifié avec un module Node est bloqué", () => {
    const dir = join(temp(), "timer");
    cpSync(join(SDK_DIR, "examples", "timer"), dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), 'import { readFileSync } from "node:fs";\n' + readFileSync(join(dir, "index.ts"), "utf8"));
    expect(checkPlugin(dir).findings.some((f) => f.code === "import" && f.severity === "block")).toBe(true);
  });
});
