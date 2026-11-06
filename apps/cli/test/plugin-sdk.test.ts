// Le gabarit et les exemples du SDK passent les contrôles d'installation et démarrent dans le processus isolé.
import { describe, it, expect, afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlugin } from "../src/plugins/check.ts";
import { newPlugin, SDK_DIR } from "../src/plugins/scaffold.ts";
import { loadPluginDir, throwawayTest } from "../src/user-plugins.ts";

const tmp: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "floppy-sdk-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("SDK des plugins", () => {
  it.each(["minuteur", "meteo"])("l'exemple %s passe les contrôles et démarre isolé", async (name) => {
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
    expect(t).toMatchObject({ ok: true, tools: [{ name: "mon_essai_bonjour", level: "read" }], settings: [{ key: "mon_essai_poli", risk: "free" }] });
    expect(() => newPlugin("mon-essai", parent)).toThrow();
    expect(() => newPlugin("Mauvais Id", parent)).toThrow();
  }, 30_000);

  it("un exemple modifié avec un module Node est bloqué", () => {
    const dir = join(temp(), "minuteur");
    cpSync(join(SDK_DIR, "examples", "minuteur"), dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), 'import { readFileSync } from "node:fs";\n' + readFileSync(join(dir, "index.ts"), "utf8"));
    expect(checkPlugin(dir).findings.some((f) => f.code === "import" && f.severity === "block")).toBe(true);
  });
});
