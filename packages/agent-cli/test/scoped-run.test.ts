import { it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type Context } from "@floppy/core";
import type { McpEndpoint } from "@floppy/contracts";
import { scopedAgentRun } from "../src/scoped-run.ts";

it("les missions simultanées ont des jetons et dossiers distincts ; erreurs et fin retirent leurs ressources", async () => {
  let context: Context | undefined;
  const plugin = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT" }, apply(ctx) { context = ctx; } });
  const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "scoped-agent-")), logger: () => {}, plugins: [plugin] });
  const closed: string[] = [], folders: string[] = []; let counter = 0, stopped = 0;
  const mcp: McpEndpoint = { url: "http://127.0.0.1:1", token: "FULL", scoped() {
    const token = `scope-${++counter}`; return { url: this.url, token, close() { closed.push(token); } };
  } };
  try {
    await k.applyConfig({ plugins: [{ id: "probe", plugin: "probe" }] });
    const run = scopedAgentRun(context!, mcp, (scope, cwd, input) => {
      folders.push(cwd); expect(existsSync(cwd)).toBe(true); expect(scope.token).not.toBe("FULL");
      return { name: "fake", reset() {}, async stop() { stopped++; }, async *run() {
        await Promise.resolve();
        yield { type: "done", text: "ok", info: input.text === "fail" ? { is_error: true } : {} };
      } };
    });
    const collect = async (text: string, model?: string) => { for await (const _ of run({ text, model, mode: "text", session: "s" })) { /* vidé */ } };
    await Promise.all([collect("a"), collect("b")]);
    expect(new Set(folders).size).toBe(2); expect(closed).toHaveLength(2);
    expect(folders.every((dir) => !existsSync(dir))).toBe(true);
    await expect(collect("fail")).rejects.toThrow();
    expect(closed).toHaveLength(3); expect(stopped).toBe(3);
    await expect(collect("x", "--unsafe")).rejects.toThrow("Nom de modèle refusé");
    expect(closed).toHaveLength(3);
  } finally { await k.stopAll(); }
});
