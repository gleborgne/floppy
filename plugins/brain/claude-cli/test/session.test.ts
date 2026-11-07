import { it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, definePlugin } from "@floppy/core";
import type { LlmService, BrainService, BrainRunInput } from "@floppy/contracts";
import claude from "../src/index.ts";

async function boot(timeout = 5) {
  let brain: BrainService;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", slots: [
    { id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" },
  ] }, async apply(ctx) { brain = (await ctx.slot<LlmService>("brain.main"))!.agent!; } });
  const mcp = definePlugin({ manifest: { id: "mcp", version: "0", licence: "MIT", provides: ["mcp"] }, apply(ctx) {
    ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", token: "t", scoped: () => ({ url: "", token: "", close() {} }) });
  } });
  const tested = { ...claude, manifest: { ...claude.manifest, permissions: { ...claude.manifest.permissions, exec: ["node"] } } };
  const k = new Kernel({ home: mkdtempSync(join(tmpdir(), "claude-session-")), logger: () => {}, plugins: [tested, mcp, probe] });
  await k.applyConfig({ slots: { "brain.main": "c/claude" }, plugins: [
    { id: "mcp", plugin: "mcp" }, { id: "c", plugin: "brain-claude-cli", config: {
      exe: process.execPath, exeArgs: [fileURLToPath(new URL("./fixtures/fake-brain.mjs", import.meta.url))], timeout_s: timeout,
    } }, { id: "probe", plugin: "probe" },
  ] });
  const run = async (text: string, extra: Partial<BrainRunInput> = {}) => {
    let result = "";
    for await (const ev of brain.run({ text, session: "s", mode: "text", ...extra })) if (ev.type === "done") result = ev.text;
    return result ? JSON.parse(result) as { pid: number; inputs: string[]; model: string } : undefined;
  };
  return { k, brain: brain!, run };
}

it("garde le processus et le ton, sans répéter la consigne aux tours suivants", async () => {
  const { k, brain, run } = await boot();
  try {
    const a = (await run("bonjour", { tone: "joueur" }))!;
    expect(a.inputs[0]).toContain("joueur");
    const b = (await run("suite", { tone: "joueur" }))!;
    expect(b.pid).toBe(a.pid);
    expect(b.inputs).toEqual([a.inputs[0], "suite"]);
    const c = (await run("encore", { tone: "calme" }))!;
    expect(c.inputs[2]).toContain("calme");
    expect((await run("fin", { tone: "calme" }))!.inputs[3]).toBe("fin");
    const other = (await run("ailleurs", { session: "autre", tone: "joueur" }))!;
    expect(other.pid).not.toBe(a.pid);
    expect(other.inputs).toHaveLength(1);
    brain.reset("s");
    const reset = (await run("neuf", { tone: "joueur" }))!;
    expect(reset.pid).not.toBe(a.pid);
    expect(reset.inputs).toHaveLength(1);
    expect(reset.inputs[0]).toContain("joueur");
  } finally { await k.stopAll(); }
});

it("remplace la session après un changement de modèle ou un processus mort", async () => {
  const { k, run } = await boot();
  try {
    const a = (await run("bonjour"))!;
    await k.items.provider("claude-cli")!.update!("claude", { model: "opus" });
    const b = (await run("suite"))!;
    expect(b.pid).not.toBe(a.pid);
    expect(b.model).toBe("opus");
    expect(await run("crash")).toBeUndefined();
    const history = [{ role: "user" as const, text: "souvenir" }];
    const c = (await run("retour", { history }))!;
    expect(c.pid).not.toBe(b.pid);
    expect(c.inputs[0]).toContain("souvenir");
    expect((await run("suite", { history }))!.inputs[1]).toBe("suite");
  } finally { await k.stopAll(); }
});

it("coupe le processus lors d'une interruption et repart proprement", async () => {
  const { k, brain, run } = await boot();
  try {
    const abort = new AbortController();
    let pid: number | undefined;
    for await (const ev of brain.run({ text: "lent", session: "s", mode: "text", signal: abort.signal })) {
      if (ev.type === "text") { pid = JSON.parse(ev.delta).pid; abort.abort(); }
    }
    expect(pid).toBeDefined();
    expect((await run("retour"))!.pid).not.toBe(pid);
  } finally { await k.stopAll(); }
});

it("borne un tour bloqué et ne transmet pas une demande déjà annulée", async () => {
  const { k, brain, run } = await boot(1);
  try {
    let info: Record<string, unknown> = {};
    for await (const ev of brain.run({ text: "lent", session: "s", mode: "text" })) if (ev.type === "done") info = ev.info!;
    expect(info.timeout).toBe(true);
    const signal = AbortSignal.abort();
    expect(await run("annulé", { signal })).toBeUndefined();
    expect((await run("retour"))!.inputs).toEqual(["retour"]);
  } finally { await k.stopAll(); }
});
