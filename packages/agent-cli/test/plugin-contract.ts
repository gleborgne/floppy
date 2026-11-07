// Même contrat testé par chaque plugin : découvrir, ouvrir au bon modèle, désactiver, refuser les options injectées.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type Context, type PluginDef } from "@floppy/core";
import { borrowAgent } from "../src/offers.ts";

export function agentPluginContract(plugin: PluginDef<any>, id: string, flag?: string) {
  describe(`contrat ${id}`, () => {
    it("découverte sans lancer de processus, modèle ponctuel et désactivation", async () => {
      let consumer: Context | undefined;
      const mcp = definePlugin({ manifest: { id: "test-mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
        ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "test", scoped: () => ({ url: "", token: "", close() {} }) });
      } });
      const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", optional: ["agent"] }, apply(ctx) { consumer = ctx; } });
      const k = new Kernel({ home: mkdtempSync(join(tmpdir(), `agent-${id}-`)), logger: () => {}, plugins: [plugin, mcp, probe] });
      try {
        await k.applyConfig({ plugins: [{ id: "mcp", plugin: "test-mcp" }, { id: "a", plugin: plugin.manifest.id, config: { exe: process.execPath } }, { id: "p", plugin: "probe" }] });
        expect(consumer!.offers("agent").map((o) => o.value)).toEqual([`a/${id}`]);
        const b = await borrowAgent(consumer!, id);
        expect(b).toBeDefined();
        try {
          const plan = b!.service.interactive({ prompt: "Read the file C:/example/task.md and do what it asks.", model: "provider/Model-1" });
          expect(plan.command).toBe(process.execPath);
          expect(plan.args).toEqual(expect.arrayContaining(["--model", "provider/Model-1"]));
          if (flag) {
            expect(plan.args).toContain(flag);
            if (id === "aider") expect(readFileSync(plan.args[plan.args.indexOf(flag) + 1]!, "utf8")).toMatch(/^\/code Read the file/);
          }
          expect(() => b!.service.interactive({ prompt: "x", model: "--allow-all" })).toThrow();
        } finally { b!.release(); }
        await k.items.provider("a-agent")!.setEnabled!(id, false);
        expect(consumer!.offers("agent")).toEqual([]);
        await k.items.provider("a-agent")!.setEnabled!(id, true);
        await k.items.provider("a-agent")!.update!(id, { exe: join(k.home, "programme-absent") });
        expect(consumer!.offers("agent")).toEqual([]);
      } finally { await k.stopAll(); }
    });
  });
}
