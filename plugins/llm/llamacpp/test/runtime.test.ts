// Cycle de vie d'un modèle local : un fork par modèle choisi, llama-server lancé à la demande et tué avec le fork.
// exe donné dans la config : le test ne dépend pas d'un llama-server installé sur la machine (CI).
import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Kernel, definePlugin } from "@floppy/core";
import type { LlmService } from "@floppy/contracts";
import llm from "../src/index.ts";

it("lance llama-server pour le modèle du slot, tue l'ancien avant le nouveau (max 1), l'arrête quand plus personne ne s'en sert", async () => {
  const state = { running: false, killed: 0 };
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (!state.running) throw new Error("stopped");
    return new Response("{}");
  }));
  const spawned: string[] = [];
  // Faux processus : ctx.spawn du plugin est remplacé ; stop() (kill) « tue » le processus.
  const wrapped: typeof llm = {
    ...llm,
    apply: (ctx, cfg) => llm.apply({
      ...ctx,
      alive: true,
      spawn: ((_cmd: string, args: string[]) => {
        spawned.push(args[args.indexOf("--alias") + 1]!);
        state.running = true;
        return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => { state.killed++; state.running = false; } });
      }) as unknown as typeof ctx.spawn,
    } as typeof ctx, cfg),
  };
  let got: LlmService | undefined;
  const consumer = definePlugin({
    manifest: { id: "consumer", version: "0", licence: "MIT", slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" }] },
    async apply(c) { got = await c.slot<LlmService>("brain.main"); },
  });
  const k = new Kernel({ logger: () => {}, plugins: [wrapped, consumer] });
  const base = { id: "llm", plugin: "llm-llamacpp", config: { exe: "llama-server", scanDirs: [], models: { a: { label: "A", model: "a.gguf" }, b: { label: "B", model: "b.gguf" } } } };
  try {
    // Sans consommateur : rien ne tourne.
    await k.applyConfig({ plugins: [base], slots: { "brain.main": "llm/a" } });
    expect(spawned).toEqual([]);
    await k.applyConfig({ plugins: [base, { id: "c", plugin: "consumer" }], slots: { "brain.main": "llm/a" } });
    expect(spawned).toEqual(["a"]);
    expect(got).toMatchObject({ model: "a", label: "A" });
    expect((await k.settings.change("slot.brain.main", "llm/b", "ui")).ok).toBe(true);
    expect(spawned).toEqual(["a", "b"]);
    expect(state.killed).toBe(1);
    expect(got?.model).toBe("b");
    // Le consommateur part : le modèle est libéré.
    await k.applyConfig({ plugins: [base], slots: { "brain.main": "llm/a" } });
    expect(state.killed).toBe(2);
    expect(state.running).toBe(false);
    expect(k.status().find((s) => s.id === "llm")?.state).toBe("active"); // le catalogue reste
  } finally { await k.stopAll(); vi.unstubAllGlobals(); }
});

const FENCED = ["```json", "{\"ok\":true}", "```"].join(String.fromCharCode(10));

it("le tri (completion « cerveau ») partage le serveur du cerveau : jamais un 2e modèle", async () => {
  const state = { running: false, killed: 0 };
  const calls: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
    if (!state.running) throw new Error("stopped");
    if (init?.body) { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: FENCED } }] })); }
    return new Response("{}");
  }));
  const spawned: string[] = [];
  const wrapped: typeof llm = {
    ...llm,
    apply: (ctx, cfg) => llm.apply({
      ...ctx,
      alive: true,
      spawn: ((_cmd: string, args: string[]) => {
        spawned.push(args[args.indexOf("--alias") + 1]!);
        state.running = true;
        return Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => { state.killed++; state.running = false; } });
      }) as unknown as typeof ctx.spawn,
    } as typeof ctx, cfg),
  };
  let brainCtx: import("@floppy/core").Context | undefined;
  const brain = definePlugin({
    manifest: { id: "brain", version: "0", licence: "MIT", slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau" }] },
    async apply(c) { await c.slot<LlmService>("brain.main"); },
  });
  const veille = definePlugin({
    manifest: { id: "veille", version: "0", licence: "MIT", slots: [{ id: "veille.tri", service: "completion", section: "veille", label: "Tri" }] },
    apply(c) { brainCtx = c; },
  });
  const k = new Kernel({ logger: () => {}, plugins: [wrapped, brain, veille] });
  const base = { id: "llm", plugin: "llm-llamacpp", config: { exe: "llama-server", scanDirs: [], models: { a: { label: "A", model: "a.gguf" }, b: { label: "B", model: "b.gguf" } } } };
  try {
    await k.applyConfig({ plugins: [base, { id: "v", plugin: "veille" }], slots: { "brain.main": "llm/a", "veille.tri": "llm/cerveau" } });
    // Le cerveau dort : le tri charge le modèle du cerveau, puis le libère.
    const b1 = await brainCtx!.borrow<import("@floppy/contracts").CompletionService>("veille.tri");
    expect(spawned).toEqual(["a"]);
    const r = await b1!.service.complete({ system: "s", prompt: "p", schema: { type: "object" } });
    expect(r.json).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ model: "a", chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema" } });
    b1!.release();
    await k.idle(); await k.idle();
    expect(state.killed).toBe(1);
    // Le cerveau tourne : le tri réutilise son serveur (pas de 2e lancement), et le serveur reste après le tri.
    await k.applyConfig({ plugins: [base, { id: "v", plugin: "veille" }, { id: "brain", plugin: "brain" }], slots: { "brain.main": "llm/a", "veille.tri": "llm/cerveau" } });
    expect(spawned).toEqual(["a", "a"]);
    const b2 = await brainCtx!.borrow<import("@floppy/contracts").CompletionService>("veille.tri");
    expect(spawned).toEqual(["a", "a"]);
    b2!.release();
    await k.idle(); await k.idle();
    expect(state.running).toBe(true);
    expect(state.killed).toBe(1);
  } finally { await k.stopAll(); vi.unstubAllGlobals(); }
});
