import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Kernel, definePlugin, type PluginDef, type KernelConfigInput, type ServiceName } from "../src/index.ts";

const quiet = () => {};

/** Plugin factice : fournit et attend des services, note ses démarrages et arrêts. */
function fake(id: string, opts: { provides?: ServiceName[]; inject?: ServiceName[]; optional?: ServiceName[]; fail?: boolean } = {}, journal: string[] = []): PluginDef<any> {
  return definePlugin({
    manifest: { id, version: "0", licence: "MIT", provides: opts.provides ?? [], inject: opts.inject ?? [], optional: opts.optional ?? [] },
    config: z.object({ v: z.number().default(0) }),
    apply(ctx, cfg: { v: number }) {
      journal.push(`start ${ctx.id}`);
      ctx.effect(() => { journal.push(`stop ${ctx.id}`); });
      if (opts.fail) throw new Error("boum");
      for (const s of opts.provides ?? []) ctx.provide(s, { from: ctx.id, v: cfg.v });
    },
  });
}

function cfg(plugins: KernelConfigInput["plugins"], services: Record<string, string> = {}): KernelConfigInput {
  return { plugins, services };
}

describe("Kernel", () => {
  it("démarre dans l'ordre des dépendances, même si la config est dans l'autre ordre", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [fake("pa", { provides: ["a"] }, j), fake("pb", { inject: ["a"] }, j)] });
    await k.applyConfig(cfg([{ id: "b", plugin: "pb" }, { id: "a", plugin: "pa" }]));
    expect(j).toEqual(["start a", "start b"]);
    expect(k.status().map((s) => s.state)).toEqual(["active", "active"]);
  });

  it("signale un service manquant (état waiting, jamais en silence)", async () => {
    const k = new Kernel({ logger: quiet, plugins: [fake("pb", { inject: ["a"] })] });
    const states: unknown[] = [];
    k.bus.on("plugin.state", (s) => states.push(s));
    await k.applyConfig(cfg([{ id: "b", plugin: "pb" }]));
    expect(k.status()[0]).toMatchObject({ state: "waiting", missing: ["a"] });
    expect(states).toContainEqual(expect.objectContaining({ id: "b", state: "waiting", missing: ["a"] }));
  });

  it("ferme tous les effets d'un plugin, dans l'ordre inverse", async () => {
    const order: number[] = [];
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) { for (const n of [1, 2, 3]) ctx.effect(() => { order.push(n); }); },
    });
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig(cfg([{ id: "p", plugin: "p" }]));
    await k.applyConfig(cfg([]));
    expect(order).toEqual([3, 2, 1]);
  });

  it("changer de fournisseur (services:) redémarre seulement les dépendants", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [
      fake("brain-a", { provides: ["brain"] }, j), fake("brain-b", { provides: ["brain"] }, j),
      fake("conv", { inject: ["brain"] }, j), fake("other", {}, j),
    ] });
    const plugins = [{ id: "ba", plugin: "brain-a" }, { id: "bb", plugin: "brain-b" }, { id: "conv", plugin: "conv" }, { id: "other", plugin: "other" }];
    await k.applyConfig(cfg(plugins, { brain: "ba" }));
    expect(k.service<{ from: string }>("brain")?.from).toBe("ba");
    j.length = 0;
    await k.applyConfig(cfg(plugins, { brain: "bb" }));
    expect(j).toEqual(["stop conv", "start conv"]);
    expect(k.service<{ from: string }>("brain")?.from).toBe("bb");
  });

  it("changer la config d'un fournisseur redémarre lui et ses dépendants, pas les autres", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [fake("pa", { provides: ["a"] }, j), fake("pb", { inject: ["a"] }, j), fake("pc", {}, j)] });
    await k.applyConfig(cfg([{ id: "a", plugin: "pa" }, { id: "b", plugin: "pb" }, { id: "c", plugin: "pc" }]));
    j.length = 0;
    await k.applyConfig(cfg([{ id: "a", plugin: "pa", config: { v: 2 } }, { id: "b", plugin: "pb" }, { id: "c", plugin: "pc" }]));
    expect(j).toEqual(["stop b", "stop a", "start a", "start b"]);
    expect(k.service<{ v: number }>("a")?.v).toBe(2);
  });

  it("désactiver un fournisseur met ses dépendants en attente", async () => {
    const k = new Kernel({ logger: quiet, plugins: [fake("pa", { provides: ["a"] }), fake("pb", { inject: ["a"] })] });
    await k.applyConfig(cfg([{ id: "a", plugin: "pa" }, { id: "b", plugin: "pb" }]));
    await k.applyConfig(cfg([{ id: "a", plugin: "pa", disabled: true }, { id: "b", plugin: "pb" }]));
    expect(k.status().map((s) => [s.id, s.state])).toEqual([["a", "disabled"], ["b", "waiting"]]);
  });

  it("apply qui échoue : état error, effets fermés", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [fake("p", { fail: true }, j)] });
    await k.applyConfig(cfg([{ id: "p", plugin: "p" }]));
    expect(k.status()[0]).toMatchObject({ state: "error", error: expect.stringContaining("boum") });
    expect(j).toEqual(["start p", "stop p"]);
  });

  it("config invalide ou plugin inconnu : erreur visible", async () => {
    const k = new Kernel({ logger: quiet, plugins: [fake("p")] });
    await k.applyConfig(cfg([{ id: "x", plugin: "p", config: { v: "pas un nombre" } }, { id: "y", plugin: "nope" }]));
    expect(k.status()[0]?.error).toMatch(/config invalide/);
    expect(k.status()[1]?.error).toMatch(/plugin inconnu/);
  });

  it("ctx.fail après le démarrage : erreur, dépendants arrêtés puis en attente", async () => {
    let failA: (r: string) => void = () => {};
    const pa = definePlugin({
      manifest: { id: "pa", version: "0", licence: "MIT", provides: ["a"] },
      apply(ctx) { ctx.provide("a", 1); failA = ctx.fail; },
    });
    const k = new Kernel({ logger: quiet, plugins: [pa, fake("pb", { inject: ["a"] })] });
    await k.applyConfig(cfg([{ id: "a", plugin: "pa" }, { id: "b", plugin: "pb" }]));
    failA("processus mort");
    await k.idle();
    await k.idle();
    expect(k.status().map((s) => [s.id, s.state])).toEqual([["a", "error"], ["b", "waiting"]]);
    expect(k.status()[0]?.error).toBe("processus mort");
    await k.restart("a");
    expect(k.status().map((s) => s.state)).toEqual(["active", "active"]);
  });

  it("un service facultatif qui arrive redémarre le dépendant", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [fake("pa", { provides: ["a"] }, j), fake("pb", { optional: ["a"] }, j)] });
    await k.applyConfig(cfg([{ id: "b", plugin: "pb" }, { id: "a", plugin: "pa", disabled: true }]));
    expect(j).toEqual(["start b"]);
    await k.applyConfig(cfg([{ id: "b", plugin: "pb" }, { id: "a", plugin: "pa" }]));
    expect(j).toEqual(["start b", "start a", "stop b", "start b"]);
  });

  it("refuse un service non déclaré (provide et get)", async () => {
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) { ctx.get("brain"); },
    });
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig(cfg([{ id: "p", plugin: "p" }]));
    expect(k.status()[0]?.error).toMatch(/non déclaré/);
  });

  it("tue les processus enfants au déchargement", async () => {
    let pid = 0;
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT", permissions: { exec: ["node"] } },
      apply(ctx) { pid = ctx.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]).pid!; },
    });
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig(cfg([{ id: "p", plugin: "p" }]));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    await k.stopAll();
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5000 });
  });

  it("les hooks s'enchaînent dans l'ordre et disparaissent avec le plugin", async () => {
    const mk = (id: string, tag: string) => definePlugin({
      manifest: { id, version: "0", licence: "MIT" },
      apply(ctx) { ctx.hook("t", async (x, next) => next([...x, tag])); },
    });
    const k = new Kernel({ logger: quiet, plugins: [mk("p1", "1"), mk("p2", "2")] });
    await k.applyConfig(cfg([{ id: "p1", plugin: "p1" }, { id: "p2", plugin: "p2" }]));
    expect(await k.hooks.run("t", [], async (x) => x)).toEqual(["1", "2"]);
    await k.applyConfig(cfg([{ id: "p2", plugin: "p2" }]));
    expect(await k.hooks.run("t", [], async (x) => x)).toEqual(["2"]);
  });
  it("replacePlugin : relance les entrées du plugin avec le nouveau code, et leurs dépendants", async () => {
    const j: string[] = [];
    const v = (n: string) => definePlugin({
      manifest: { id: "pa", version: n, licence: "MIT", provides: ["a"] },
      apply(ctx) { j.push(`start pa ${n}`); ctx.effect(() => { j.push(`stop pa ${n}`); }); ctx.provide("a", { n }); },
    });
    const k = new Kernel({ logger: quiet, plugins: [v("1"), fake("pb", { inject: ["a"] }, j)] });
    await k.applyConfig(cfg([{ id: "a", plugin: "pa" }, { id: "b", plugin: "pb" }]));
    j.length = 0;
    await k.replacePlugin(v("2"));
    expect(j).toEqual(["stop b", "stop pa 1", "start pa 2", "start b"]);
    expect(k.service<{ n: string }>("a")?.n).toBe("2");
    // Plugin nouveau : simplement enregistré.
    await k.replacePlugin(fake("pz"));
    await k.applyConfig(cfg([{ id: "z", plugin: "pz" }]));
    expect(k.status()[0]).toMatchObject({ id: "z", state: "active" });
  });

  it("setExtraEntries : entrées en plus, gardées par applyConfig, ignorées si l'id est pris", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [fake("pa", {}, j), fake("pu", {}, j)] });
    await k.setExtraEntries([{ id: "u-x", plugin: "pu", disabled: false }]); // avant toute config : gardé
    await k.applyConfig(cfg([{ id: "a", plugin: "pa" }]));
    expect(k.status().map((s) => s.id)).toEqual(["a", "u-x"]);
    await k.applyConfig(cfg([{ id: "a", plugin: "pa", config: { v: 1 } }]));
    expect(k.status().map((s) => s.id)).toEqual(["a", "u-x"]);
    expect(j.filter((x) => x === "start u-x")).toHaveLength(1); // pas redémarrée
    await k.setExtraEntries([{ id: "a", plugin: "pu", disabled: false }]); // collision : ignorée
    expect(k.status().map((s) => s.id)).toEqual(["a"]);
    expect(j).toContain("stop u-x");
    await k.setExtraEntries([]);
    expect(k.status().map((s) => s.id)).toEqual(["a"]);
  });
});
