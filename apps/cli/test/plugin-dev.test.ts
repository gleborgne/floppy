// Mode debug (`floppy dev`) : le plugin d'un dossier quelconque démarre sans clic, se recharge à chaque sauvegarde,
// et ses outils s'appellent par le point de contrôle (`floppy tool`).
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlCall } from "@floppy/core";
import { boot, type Running } from "../src/boot.ts";
import { newPlugin } from "../src/plugins/scaffold.ts";

const tmp: string[] = [];
const running: Running[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "floppy-dev-")); tmp.push(d); return d; };
const prevHome = process.env.FLOPPY_HOME;
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  process.env.FLOPPY_HOME = prevHome;
  if (prevHome === undefined) delete process.env.FLOPPY_HOME;
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(devDir: string): Promise<{ r: Running; home: string }> {
  const home = temp();
  process.env.FLOPPY_HOME = home;
  const config = join(home, "floppy.yml");
  writeFileSync(config, "plugins: []\n");
  const r = await boot({ configPath: config, plugins: [], devDirs: [devDir], watch: false, logger: () => {} });
  running.push(r);
  return { r, home };
}

async function until(fn: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("délai dépassé");
}

describe("mode debug", () => {
  it("plugin distribué : actif sans clic, outil appelé par le point de contrôle, rechargé à la sauvegarde", async () => {
    const dir = newPlugin("essai-dev", temp());
    const { r, home } = await start(dir);
    expect(r.kernel.status().find((e) => e.id === "u-essai-dev")?.state).toBe("active");
    expect((await controlCall(home, "POST", "/tool", { name: "essai_dev_bonjour", args: { nom: "Ada" } })).data).toMatchObject({ status: "done", text: "Bonjour Ada !" });
    // Un appel d'outil inconnu ne casse rien.
    expect((await controlCall(home, "POST", "/tool", { name: "nexiste_pas", args: {} })).data.status).toBe("failed");

    const src = (await import("node:fs")).readFileSync(join(dir, "index.ts"), "utf8");
    writeFileSync(join(dir, "index.ts"), src.replace("`Bonjour ${nom} !`", "`Coucou ${nom} !`"));
    await until(async () => (await controlCall(home, "POST", "/tool", { name: "essai_dev_bonjour", args: { nom: "Ada" } })).data.text === "Coucou Ada !");
    // Le mode debug ne s'éteint pas d'un réglage.
    await r.kernel.settings.change("plugin_essai_dev", false, "ui");
    expect(r.kernel.status().find((e) => e.id === "u-essai-dev")?.state).toBe("active");
  }, 30_000);

  it("plugin personnel (sans floppy-plugin.json) : chargé dans le noyau, une erreur de syntaxe est signalée puis corrigée", async () => {
    const dir = join(temp(), "perso");
    mkdirSync(dir);
    const code = (t: string) => `export default { manifest: { id: "perso", version: "1", licence: "MIT" }, apply(ctx: any) { ctx.tools.register([{ name: "perso_t", description: "d", inputSchema: { type: "object" }, level: "read", handler: async () => ({ status: "done", text: "${t}" }) }]); } };\n`;
    writeFileSync(join(dir, "index.ts"), code("v1"));
    const { r, home } = await start(dir);
    expect((await controlCall(home, "POST", "/tool", { name: "perso_t" })).data.text).toBe("v1");
    writeFileSync(join(dir, "index.ts"), "export default {{{");
    await until(async () => r.kernel.settings.list().some((s) => s.key === "plugin_perso" && JSON.stringify(s.description).includes("erreur")));
    writeFileSync(join(dir, "index.ts"), code("v2"));
    await until(async () => (await controlCall(home, "POST", "/tool", { name: "perso_t" })).data.text === "v2");
  }, 30_000);
});

describe("app de bureau", () => {
  it("FLOPPY_DEV_PLUGINS : dossiers séparés comme le PATH", async () => {
    const { envDevDirs } = await import("../src/boot.ts");
    const { delimiter } = await import("node:path");
    const prev = process.env.FLOPPY_DEV_PLUGINS;
    process.env.FLOPPY_DEV_PLUGINS = ["a", " b ", ""].join(delimiter);
    try { expect(envDevDirs()).toEqual(["a", "b"]); } finally {
      if (prev === undefined) delete process.env.FLOPPY_DEV_PLUGINS; else process.env.FLOPPY_DEV_PLUGINS = prev;
    }
  });
});
