import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, definePlugin } from "@floppy/core";
import type { LlmService, BrainService } from "@floppy/contracts";
import claude from "../src/index.ts";

it("Claude découvre ses modèles sans prompt et applique les deux choix au prochain tour", async () => {
  let main: LlmService | undefined, delegate: BrainService | undefined;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", slots: [
    { id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" },
    { id: "brain.delegate", service: "delegate", section: "cerveau", label: "Délégation" },
  ] }, async apply(ctx) { main = await ctx.slot<LlmService>("brain.main"); delegate = await ctx.slot<BrainService>("brain.delegate"); } });
  const mcp = definePlugin({ manifest: { id: "mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
    ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) });
  } });
  const tested = { ...claude, manifest: { ...claude.manifest, permissions: { ...claude.manifest.permissions, exec: ["node"] } } };
  const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "claude-models-")), logger: () => {}, plugins: [tested, mcp, probe] });
  try {
    await k.applyConfig({ slots: { "brain.main": "c/claude", "brain.delegate": "c/claude" }, plugins: [
      { id: "mcp", plugin: "mcp" }, { id: "c", plugin: "brain-claude-cli", config: {
        exe: process.execPath, exeArgs: [fileURLToPath(new URL("./fixtures/fake-brain.mjs", import.meta.url))],
      } }, { id: "probe", plugin: "probe" },
    ] });
    const prov = k.items.provider("claude-cli")!;
    expect((await prov.action!("claude", "refresh-models")).ok).toBe(true);
    for (const f of prov.kinds![0]!.fields) expect(f.options).toContainEqual({ value: "claude-future", label: "Claude Future" });
    expect((await prov.update!("claude", { model: "claude-future", delegateModel: "claude-future" })).ok).toBe(true);
    expect(delegate!.name).toBe("claude:claude-future");
    let result = "";
    for await (const ev of main!.agent!.run({ text: "bonjour", session: "s", mode: "text" })) if (ev.type === "done") result = ev.text;
    expect(JSON.parse(result).model).toBe("claude-future");
  } finally { await k.stopAll(); }
});
