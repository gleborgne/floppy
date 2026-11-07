// Un noyau qui ne se bloque jamais : délais, contexte inerte après l'arrêt, pannes attribuées, reprise automatique,
// emprunteurs prévenus, middlewares isolés, accords annulés à l'arrêt.
import { describe, it, expect } from "vitest";
import { Kernel, definePlugin, type Context, type PluginDef, type Borrowed } from "../src/index.ts";

const quiet = () => {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

function kernel(plugins: PluginDef<any>[], opts: Partial<ConstructorParameters<typeof Kernel>[0]> = {}) {
  const logs: string[] = [];
  const k = new Kernel({ plugins, logger: (r) => logs.push(`${r.level} ${r.source} ${r.msg}`), ...opts });
  return { k, logs };
}
const state = (k: Kernel, id: string) => k.status().find((s) => s.id === id);

describe("délais", () => {
  it("un apply qui ne finit jamais passe en erreur, et le noyau continue", async () => {
    const closed: string[] = [];
    const stuck = definePlugin({ manifest: { id: "stuck", version: "0", licence: "MIT" }, async apply(ctx) { ctx.effect(() => { closed.push("stuck"); }); await never(); } });
    const ok = definePlugin({ manifest: { id: "ok", version: "0", licence: "MIT" }, apply() {} });
    const { k } = kernel([stuck, ok], { startTimeoutMs: 50, retryDelays: [] });
    await k.applyConfig({ plugins: [{ id: "stuck", plugin: "stuck" }, { id: "ok", plugin: "ok" }] });
    expect(state(k, "stuck")?.state).toBe("error");
    expect(state(k, "stuck")?.error).toMatch(/trop long/);
    expect(closed).toEqual(["stuck"]);
    expect(state(k, "ok")?.state).toBe("active");
    await k.stopAll();
  });

  it("le temps passé à démarrer un autre plugin (ctx.use) ne compte pas", async () => {
    const slow = definePlugin({
      manifest: { id: "slow", version: "0", licence: "MIT", provides: ["llm"], lazy: true, startTimeout_s: 5 },
      async apply(ctx) { await wait(120); ctx.provide("llm", { baseURL: "x", model: "m" }); },
    });
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", optional: ["llm"], startTimeout_s: 0.08 },
      async apply(ctx) { await ctx.use("llm"); },
    });
    const { k } = kernel([slow, user]);
    await k.applyConfig({ plugins: [{ id: "slow", plugin: "slow" }, { id: "user", plugin: "user" }] });
    expect(state(k, "user")?.state).toBe("active");
    await k.stopAll();
  });

  it("une fermeture bloquée est abandonnée : l'arrêt finit quand même", async () => {
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(ctx) { ctx.effect(never); } });
    const { k, logs } = kernel([p], { disposeTimeoutMs: 50 });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await k.stopAll();
    expect(state(k, "p")?.state).toBe("loaded");
    expect(logs.some((l) => l.includes("fermeture trop longue"))).toBe(true);
  });

  it("l'arrêt de Floppy n'attend pas un démarrage en cours", async () => {
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT", startTimeout_s: 600 }, async apply() { await never(); } });
    const { k } = kernel([p]);
    void k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await wait(20);
    const t = Date.now();
    await k.stopAll();
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("contexte fermé", () => {
  it("après l'arrêt, le plugin ne peut plus émettre ni appeler d'outil", async () => {
    let ctx!: Context;
    const seen: unknown[] = [];
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(c) { ctx = c; } });
    const watcher = definePlugin({ manifest: { id: "w", version: "0", licence: "MIT" }, apply(c) { c.on("x", (v) => seen.push(v)); } });
    const { k, logs } = kernel([p, watcher]);
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }, { id: "w", plugin: "w" }] });
    ctx.emit("x", 1);
    await k.applyConfig({ plugins: [{ id: "w", plugin: "w" }] });
    ctx.emit("x", 2);
    await expect(ctx.tools.call("lister_reglages", {})).rejects.toThrow(/arrêté/);
    expect(await ctx.approvals.check({ tool: "t", args: {}, level: "write", summary: "?" })).toMatchObject({ ok: false, reason: "cancelled" });
    expect(seen).toEqual([1]);
    expect(logs.some((l) => l.includes("emit(x) après l'arrêt"))).toBe(true);
    await k.stopAll();
  });

  it("les demandes d'accord d'un plugin qui s'arrête sont annulées", async () => {
    let ctx!: Context;
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(c) { ctx = c; } });
    const { k } = kernel([p]);
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    const asked = ctx.approvals.check({ tool: "t", args: {}, level: "write", summary: "?" });
    expect(k.approvals.pending()).toHaveLength(1);
    await k.stopAll();
    expect(await asked).toMatchObject({ ok: false, reason: "cancelled" });
    expect(k.approvals.pending()).toHaveLength(0);
  });
});

describe("pannes attribuées", () => {
  it("une minuterie qui plante est notée au nom du plugin, sans casser le noyau", async () => {
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(ctx) { ctx.timeout(() => { throw new Error("boum"); }, 1); } });
    const { k, logs } = kernel([p]);
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await wait(20);
    expect(logs.some((l) => l.startsWith("error p minuterie") && l.includes("boum"))).toBe(true);
    expect(state(k, "p")?.state).toBe("active");
    await k.stopAll();
  });

  it("une exception non rattrapée est rendue au plugin dont le code tournait, qui passe en panne", async () => {
    // Le filet global appelle blame pendant que le code du plugin tourne (ici : une minuterie lancée par apply).
    let blamed: string | undefined;
    let k!: Kernel;
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply() { setTimeout(() => { blamed = k.blame("uncaughtException", new Error("cassé")); }, 1); },
    });
    ({ k } = kernel([p], { retryDelays: [] }));
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await wait(20);
    expect(blamed).toBe("p");
    await k.idle();
    expect(state(k, "p")?.state).toBe("error");
    expect(state(k, "p")?.error).toMatch(/cassé/);
    expect(k.blame("unhandledRejection", new Error("hors plugin"))).toBeUndefined();
  });

  it("un middleware qui plante avant next() bloque l'action ; après next() réussi, le résultat est gardé", async () => {
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) {
        ctx.hook("refuse", async () => { throw new Error("interdit"); });
        ctx.hook<number, number>("apres", async (n, next) => { await next(n + 1); throw new Error("raté après coup"); });
      },
    });
    const { k, logs } = kernel([p]);
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    let ran = false;
    await expect(k.hooks.run("refuse", 1, async () => { ran = true; return 0; })).rejects.toThrow(/interdit/);
    expect(ran).toBe(false);
    expect(await k.hooks.run<number, number>("apres", 1, async (n) => n * 10)).toBe(20);
    expect(logs.some((l) => l.includes("middleware apres : erreur après la suite"))).toBe(true);
    await k.stopAll();
  });
});

describe("reprise automatique", () => {
  it("un apply qui échoue une fois repart tout seul", async () => {
    let tries = 0;
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply() { if (++tries === 1) throw new Error("pas prêt"); } });
    const { k } = kernel([p], { retryDelays: [20, 20] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(state(k, "p")?.state).toBe("error");
    await wait(60);
    await k.idle();
    expect(state(k, "p")?.state).toBe("active");
    await k.stopAll();
  });

  it("une panne après le démarrage (ctx.fail) repart, puis l'erreur reste visible après les essais", async () => {
    let ctx!: Context;
    let starts = 0;
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(c) { ctx = c; starts++; if (starts > 1) throw new Error("toujours cassé"); } });
    const { k } = kernel([p], { retryDelays: [10] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    ctx.fail("plus de connexion");
    await wait(50);
    await k.idle();
    expect(starts).toBe(2);
    expect(state(k, "p")?.state).toBe("error");
    await wait(50);
    expect(starts).toBe(2); // plus d'essai : l'erreur reste
  });

  it("un fork tombé en panne repart, et son consommateur le retrouve", async () => {
    let ctx!: Context;
    let starts = 0;
    const models = definePlugin({
      manifest: { id: "models", version: "0", licence: "MIT", provides: ["llm"] },
      apply(c) { c.offer("llm", { items: () => [{ id: "a", label: "A" }], start(f) { ctx = f; starts++; f.provide("llm", { baseURL: "x", model: "a" }); } }); },
    });
    const got: (string | undefined)[] = [];
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "s", service: "llm", section: "x", label: "S" }] },
      async apply(c) { got.push((await c.slot<{ model: string }>("s"))?.model); },
    });
    const { k } = kernel([models, user], { retryDelays: [10] });
    await k.applyConfig({ plugins: [{ id: "models", plugin: "models" }, { id: "user", plugin: "user" }] });
    ctx.fail("le programme s'est arrêté");
    await wait(60);
    await k.idle();
    expect(starts).toBe(2);
    expect(got.at(-1)).toBe("a");
    expect(state(k, "user")?.state).toBe("active");
    await k.stopAll();
  });
});

describe("emprunts", () => {
  it("l'emprunteur est prévenu quand l'élément tombe en panne", async () => {
    let fork!: Context;
    const models = definePlugin({
      manifest: { id: "models", version: "0", licence: "MIT", provides: ["llm"] },
      apply(c) { c.offer("llm", { items: () => [{ id: "a", label: "A" }], start(f) { fork = f; f.provide("llm", { baseURL: "x", model: "a" }); } }); },
    });
    let ctx!: Context;
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "s", service: "llm", section: "x", label: "S" }] },
      apply(c) { ctx = c; },
    });
    const { k } = kernel([models, user], { retryDelays: [] });
    await k.applyConfig({ plugins: [{ id: "models", plugin: "models" }, { id: "user", plugin: "user" }] });
    const b = (await ctx.borrow<{ model: string }>("s")) as Borrowed<{ model: string }>;
    expect(b.service.model).toBe("a");
    let lost = false;
    void b.lost.then(() => { lost = true; });
    fork.fail("panne");
    await k.idle();
    await wait(5);
    expect(lost).toBe(true);
    await k.stopAll();
  });
});

describe("nouveau choix pendant un chargement", () => {
  it("l'élément qui charge est annulé : le nouveau choix n'attend pas sa fin, et l'ancien ne repart pas tout seul", async () => {
    const starts: string[] = [];
    const models = definePlugin({
      manifest: { id: "models", version: "0", licence: "MIT", provides: ["llm"] },
      apply(c) {
        c.offer("llm", {
          max: 1,
          items: () => [{ id: "lent", label: "Lent" }, { id: "rapide", label: "Rapide" }],
          async start(f, item) {
            starts.push(item);
            if (item === "lent") await never();
            f.provide("llm", { baseURL: "x", model: item });
          },
        });
      },
    });
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "s", service: "llm", section: "x", label: "S" }] },
      async apply(c) { await c.slot("s"); },
    });
    const { k } = kernel([models, user], { retryDelays: [10] });
    void k.applyConfig({ plugins: [{ id: "models", plugin: "models" }, { id: "user", plugin: "user" }], slots: { s: "models/lent" } });
    await wait(20);
    const t = Date.now();
    const r = await k.settings.change("slot.s", "models/rapide", "ui");
    expect(r.ok).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(k.slots().find((s) => s.id === "s")).toMatchObject({ value: "models/rapide", state: "active" });
    await wait(40);
    expect(starts).toEqual(["lent", "rapide"]);
    await k.stopAll();
  });
});

describe("canal de l'hôte", () => {
  it("ctx.host : les écouteurs d'un plugin sont retirés à son arrêt ; absent sans hôte", async () => {
    const { EventEmitter } = await import("node:events");
    const host = Object.assign(new EventEmitter(), { sent: [] as unknown[], postMessage(m: unknown) { this.sent.push(m); } });
    const got: unknown[] = [];
    let ctx!: Context;
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT" }, apply(c) { ctx = c; c.host?.on("message", (e) => got.push(e.data)); c.host?.postMessage("bonjour"); } });
    const { k } = kernel([p], { host });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    host.emit("message", { data: 1 });
    expect(got).toEqual([1]);
    expect(host.sent).toEqual(["bonjour"]);
    await k.stopAll();
    host.emit("message", { data: 2 });
    expect(got).toEqual([1]);
    expect(host.listenerCount("message")).toBe(0);
    ctx.host?.postMessage("après");
    expect(host.sent).toEqual(["bonjour"]);
    const { k: k2 } = kernel([p]);
    await k2.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(ctx.host).toBeUndefined();
    await k2.stopAll();
  });
});

describe("revue adversariale : arrêt, attribution, délai", () => {
  it("l'arrêt de Floppy est définitif : les entrées suivantes ne démarrent pas, l'annulée n'est pas en panne", async () => {
    const applied: string[] = [];
    const slow = (id: string) => definePlugin({ manifest: { id, version: "0", licence: "MIT" }, async apply() { applied.push(id); await wait(300); } });
    const { k } = kernel([slow("a"), slow("b"), slow("c")]);
    void k.applyConfig({ plugins: [{ id: "a", plugin: "a" }, { id: "b", plugin: "b" }, { id: "c", plugin: "c" }] });
    await wait(30);
    const t = Date.now();
    await k.stopAll();
    expect(Date.now() - t).toBeLessThan(250);
    expect(applied).toEqual(["a"]);
    expect(state(k, "a")?.state).toBe("loaded");
    // Une relance de la même config redémarre tout, l'entrée annulée comprise.
    await k.applyConfig({ plugins: [{ id: "a", plugin: "a" }, { id: "b", plugin: "b" }, { id: "c", plugin: "c" }] });
    expect(["a", "b", "c"].map((id) => state(k, id)?.state)).toEqual(["active", "active", "active"]);
    await k.stopAll();
  });

  it("après l'arrêt, un emprunt rendu ne relance rien", async () => {
    const models = definePlugin({
      manifest: { id: "models", version: "0", licence: "MIT", provides: ["llm"] },
      apply(c) { c.offer("llm", { items: () => [{ id: "a", label: "A" }], start(f) { f.provide("llm", { baseURL: "x", model: "a" }); } }); },
    });
    let ctx!: Context;
    const user = definePlugin({ manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "s", service: "llm", section: "x", label: "S" }] }, apply(c) { ctx = c; } });
    const { k } = kernel([models, user]);
    await k.applyConfig({ plugins: [{ id: "models", plugin: "models" }, { id: "user", plugin: "user" }] });
    await ctx.borrow("s");
    await k.stopAll();
    await wait(50);
    await k.idle();
    expect(k.status().every((s) => s.state !== "active")).toBe(true);
  });

  it("le travail du noyau demandé par un plugin ne tourne pas à son nom", async () => {
    let blamed: string | undefined = "pas appelé";
    let k!: Kernel;
    // p tombe depuis son propre code (une minuterie : elle tourne à son nom).
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT", provides: ["svc"] }, apply(c) { c.provide("svc", {}); c.timeout(() => c.fail("crash"), 5); } });
    // q s'arrête parce que p tombe ; une erreur dans sa fermeture est à q (ou à personne), jamais à p.
    const q = definePlugin({ manifest: { id: "q", version: "0", licence: "MIT", inject: ["svc"] }, apply(c) { c.effect(() => { blamed = k.blame("unhandledRejection", new Error("fermeture de q")); }); } });
    ({ k } = kernel([p, q], { retryDelays: [] }));
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }, { id: "q", plugin: "q" }] });
    await wait(30);
    await k.idle();
    expect(blamed).toBe("q");
    await k.stopAll();
  });
});

describe("délai d'un démarrage", () => {
  it("une reprise sans pause en cours est ignorée, et rien ne se déclenche après stop()", async () => {
    const { Deadline } = await import("../src/plugin/lifecycle-util.ts");
    let fired = 0;
    const d = new Deadline(30, () => { fired++; });
    d.resume();
    d.stop();
    await wait(60);
    expect(fired).toBe(0);
    const d2 = new Deadline(30, () => { fired++; });
    d2.pause(); d2.pause(); d2.resume();
    await wait(60);
    expect(fired).toBe(0); // encore une pause en cours
    d2.resume();
    await wait(60);
    expect(fired).toBe(1);
  });
});
