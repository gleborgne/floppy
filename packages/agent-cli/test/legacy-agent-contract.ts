import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, definePlugin, type Context, type PluginDef } from "@floppy/core";
import { borrowAgent } from "../src/offers.ts";

export function legacyAgentContract(plugin: PluginDef<any>, id: string, fixture: string) {
  it(`${id} : modèle par mission et profils simultanés isolés, sans changer les modèles enregistrés`, async () => {
    let consumer: Context | undefined; let nextToken = 0; const closed: string[] = [];
    const scopes: { tools: string[] }[] = [];
    const mcp = definePlugin({ manifest: { id: "test-mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
      ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "FULL", scoped(opts) {
        scopes.push(opts); const token = `SCOPE-${++nextToken}`;
        return { url: "http://127.0.0.1:1/mcp", token, close() { closed.push(token); } };
      } });
    } });
    const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", optional: ["agent"] }, apply(ctx) { consumer = ctx; } });
    // Seul le programme injecté dans ce test change de permission ; aucun binaire n'a besoin d'être copié.
    const tested = { ...plugin, manifest: { ...plugin.manifest, permissions: { ...plugin.manifest.permissions, exec: ["node"] } } };
    const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "legacy-agent-")), logger: () => {}, plugins: [tested, mcp, probe] });
    try {
      await k.applyConfig({ plugins: [{ id: "mcp", plugin: "test-mcp" }, { id: "a", plugin: plugin.manifest.id,
        config: { exe: process.execPath, exeArgs: [fixture], userMcp: false, timeout_s: 5 } }, { id: "p", plugin: "probe" }] });
      const before = await k.items.snapshot();
      const b = await borrowAgent(consumer!, id); expect(b?.service.run).toBeDefined();
      try {
        const run = async (model: string) => {
          let text = "";
          for await (const ev of b!.service.run!({ text: "bonjour", model, mode: "text", session: model })) if (ev.type === "done") text = ev.text;
          return JSON.parse(text);
        };
        const values = await Promise.all([run("model-a"), run("model-b")]);
        expect(values.map((v) => v.model ?? v.args[v.args.indexOf("--model") + 1])).toEqual(["model-a", "model-b"]);
        if (id === "antigravity") expect(values[0].home).not.toBe(values[1].home);
        expect(new Set(closed).size).toBe(2);
        expect(await k.items.snapshot()).toEqual(before);
      } finally { b?.release(); }
    } finally { await k.stopAll(); }
  });
}
