import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, tr } from "@floppy/core";
import { sandboxedPlugin } from "../src/plugins/sandbox.ts";
import { hashDir } from "../src/plugins/check.ts";
import type { PluginPackage } from "../src/plugins/format.ts";

const dirs: string[] = [];
const kernels: Kernel[] = [];
const quiet = () => {};

/** Écrit un plugin tiers (floppy-plugin.json + index.ts) dans un dossier temporaire. */
export function writePlugin(code: string, pkg: Partial<PluginPackage> = {}): { dir: string; pkg: PluginPackage } {
  const root = mkdtempSync(join(tmpdir(), "floppy-sandbox-"));
  dirs.push(root);
  const full: PluginPackage = { id: "essai", version: "1.0.0", licence: "MIT", api: 1, ...pkg };
  const dir = join(root, full.id);
  mkdirSync(dir);
  writeFileSync(join(dir, "floppy-plugin.json"), JSON.stringify(full));
  writeFileSync(join(dir, "index.ts"), code);
  return { dir, pkg: full };
}

const manifest = (extra = "") => `manifest: { id: "essai", version: "1.0.0", licence: "MIT" ${extra} }`;

async function start(dir: string, pkg: PluginPackage, opts: Partial<Parameters<typeof sandboxedPlugin>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "floppy-sandbox-home-"));
  dirs.push(home);
  const def = sandboxedPlugin({ dir, pkg, timeouts: { start: 10_000, call: 5_000 }, ...opts });
  const k = new Kernel({ home, logger: quiet, secrets: new MemorySecrets(), plugins: [def] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "x", plugin: "essai", config: {} }], approvals: { write: "always", send: "always", delete: "always" } });
  return k;
}

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plugin tiers isolé", () => {
  it("démarre, enregistre outils et réglages, répond aux appels, garde les valeurs", async () => {
    const { dir, pkg } = writePlugin(`
import type { UserPlugin } from "./floppy-plugin.d.ts";
import { double } from "./util.ts";
const p: UserPlugin = { ${manifest()},
  apply(ctx) {
    let n = ctx.settings.saved<number>("essai_n") ?? 2;
    ctx.settings.declare([{ key: "essai_n", label: { fr: "N", en: "N" }, description: { fr: "Nombre", en: "Number" }, type: "number", section: "general", risk: "free", min: 0, max: 10, get: () => n, set: (v) => { n = Number(v); } }]);
    ctx.tools.register([{ name: "essai_double", description: "double", inputSchema: { type: "object", properties: {} }, level: "write",
      handler: async () => { n = double(n); return { status: "done", text: { fr: "n = " + n, en: "n is " + n } }; } }]);
    ctx.log("info", "prêt");
  } };
export default p;`);
    writeFileSync(join(dir, "util.ts"), "export const double = (x: number): number => x * 2;\n");
    const k = await start(dir, pkg);
    expect(k.status().find((s) => s.id === "x")?.state).toBe("active");
    const r = await k.tools.call("essai_double", {});
    expect(r).toMatchObject({ status: "done", text: "n = 4" });
    expect(k.settings.list().find((s) => s.key === "essai_n")?.value).toBe(4); // valeur renvoyée après l'appel
    expect((await k.settings.change("essai_n", 7, "ui")).ok).toBe(true);
    expect((await k.tools.call("essai_double", {})).text).toBe("n = 14");
  }, 30_000);

  it("n'a pas les services de Floppy : offers vide, get et borrowItem refusés avec un message clair", async () => {
    const { dir, pkg } = writePlugin(`
import type { UserPlugin } from "./floppy-plugin.d.ts";
const p: UserPlugin = { ${manifest()},
  apply(ctx) {
    ctx.tools.register([{ name: "essai_services", description: "services", inputSchema: { type: "object", properties: {} }, level: "read",
      handler: async () => {
        const out = ["offers:" + ctx.offers("notify").length, "maybe:" + String(ctx.maybe("documents"))];
        try { ctx.get("documents"); out.push("get ok"); } catch (e) { out.push("get: " + (e as Error).message); }
        try { await ctx.borrowItem("notify", "a/b"); out.push("borrow ok"); } catch (e) { out.push("borrow: " + (e as Error).message); }
        return { status: "done", text: out.join(" | ") };
      } }]);
  } };
export default p;`);
    const k = await start(dir, pkg);
    const text = String((await k.tools.call("essai_services", {})).text);
    expect(text).toContain("offers:0 | maybe:undefined");
    expect(text).toContain("get: un plugin tiers n'a pas accès aux services");
    expect(text).toContain("borrow: un plugin tiers n'a pas accès aux services");
  }, 30_000);

  it("refuse les modules de Node, même par contournement", async () => {
    const { dir, pkg } = writePlugin(`
const p = { ${manifest()},
  async apply(ctx: any) {
    const out: string[] = [];
    try { await import("node:" + "fs"); out.push("import ok"); } catch { out.push("import refusé"); }
    try { (process as any).getBuiltinModule("node:child_process"); out.push("gbm ok"); } catch { out.push("gbm refusé"); }
    try { new (globalThis as any).WebSocket("ws://x"); out.push("ws ok"); } catch { out.push("ws refusé"); }
    out.push("env:" + Object.keys(process.env).length);
    ctx.tools.register([{ name: "essai_res", description: "d", inputSchema: { type: "object" }, level: "read", handler: async () => ({ status: "done", text: out.join(",") }) }]);
  } };
export default p;`);
    const k = await start(dir, pkg);
    expect((await k.tools.call("essai_res", {})).text).toBe("import refusé,gbm refusé,ws refusé,env:0");
  }, 30_000);

  it("fetch passe par le noyau et seulement vers les hôtes déclarés", async () => {
    const { dir, pkg } = writePlugin(`
const p = { ${manifest(', permissions: { net: ["api.contoso.com"] }')},
  apply(ctx: any) {
    ctx.tools.register([{ name: "essai_get", description: "d", inputSchema: { type: "object", properties: { url: { type: "string" } } }, level: "read",
      handler: async (a: any) => { try { const r = await fetch(a.url); return { status: "done", text: r.status + ":" + await r.text() }; } catch (e: any) { return { status: "failed", text: e.message }; } } }]);
  } };
export default p;`, { permissions: { net: ["api.contoso.com"] } });
    const seen: string[] = [];
    const fake = (async (u: URL | string) => {
      const url = new URL(String(u));
      seen.push(url.href);
      if (url.pathname === "/go") return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
      return new Response("bonjour", { status: 200 });
    }) as typeof fetch;
    const k = await start(dir, pkg, { fetch: fake });
    expect((await k.tools.call("essai_get", { url: "https://api.contoso.com/x" })).text).toBe("200:bonjour");
    expect((await k.tools.call("essai_get", { url: "https://evil.example/x" })).text).toContain("evil.example");
    expect((await k.tools.call("essai_get", { url: "https://api.contoso.com/go" })).text).toContain("evil.example");
    expect(seen).toEqual(["https://api.contoso.com/x", "https://api.contoso.com/go"]);
  }, 30_000);

  it("refuse un manifeste de code différent du fichier JSON, et des fichiers modifiés après la revue", async () => {
    const { dir, pkg } = writePlugin(`export default { manifest: { id: "essai", version: "9.9.9", licence: "MIT" }, apply() {} };`);
    const k = await start(dir, pkg);
    expect(tr(k.status().find((s) => s.id === "x")?.error ?? "")).toContain("9.9.9");

    const ok = writePlugin(`export default { ${manifest()}, apply() {} };`);
    const hash = hashDir(ok.dir);
    writeFileSync(join(ok.dir, "index.ts"), `export default { ${manifest()}, apply() { /* changé */ } };`);
    const k2 = await start(ok.dir, ok.pkg, { expectHash: hash });
    expect(tr(k2.status().find((s) => s.id === "x")?.error ?? "")).toContain("changé");
  }, 30_000);

  it("refuse une clé de réglage sans préfixe et une émission autre qu'initiative ; un plantage met le plugin en erreur", async () => {
    const { dir, pkg } = writePlugin(`
const p = { ${manifest()},
  apply(ctx: any) {
    ctx.settings.declare([{ key: "voix", label: "x", description: "x", type: "boolean", section: "general", risk: "free", get: () => true, set() {} }]);
    ctx.emit("settings.changed", {});
    ctx.tools.register([{ name: "essai_crash", description: "d", inputSchema: { type: "object" }, level: "read", handler: async () => { setTimeout(() => process.exit(3), 10); return { status: "done", text: "bye" }; } }]);
  } };
export default p;`);
    const k = await start(dir, pkg);
    expect(k.settings.list().find((s) => s.key === "voix")).toBeUndefined();
    await k.tools.call("essai_crash", {});
    await new Promise((r) => setTimeout(r, 500));
    const st = k.status().find((s) => s.id === "x");
    expect(st?.state).toBe("error");
    expect(tr(st?.error ?? "")).toContain("code 3");
  }, 30_000);
});
