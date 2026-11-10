// Contrat « tâche » : tâches déclarées dans le manifeste, lancées par le noyau (plugin réveillé et gardé pendant le
// passage, un seul passage à la fois, annonce par le noyau) ; et ctx.borrow (emprunter un slot le temps d'un travail).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel, MemoryAudit, definePlugin, manifestError, tr, type PluginDef, type TaskService, type Context } from "../src/index.ts";

const quiet = () => {};
let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; });

const state = (kk: Kernel, id: string) => kk.status().find((s) => s.id === id)?.state;

/** Plugin endormi (lazy) avec une tâche ; `gate` permet de tenir le passage ouvert. */
function digest(j: string[], opts: { gate?: Promise<void>; fail?: boolean } = {}): PluginDef<any> {
  return definePlugin({
    manifest: {
      id: "digest", version: "0", licence: "MIT", provides: ["task"], lazy: true,
      tasks: [{ id: "quotidienne", label: "Veille du jour", schedule: { at: "07:30" } }],
    },
    apply(ctx) {
      j.push("start");
      ctx.effect(() => { j.push("stop"); });
      const svc: TaskService = {
        async run(id, input) {
          j.push(`run ${id} ${input.reason} ${input.lastRun ? "avec" : "sans"}`);
          await opts.gate;
          if (opts.fail) throw new Error("source en panne");
          return { summary: "Ta veille est prête.", document: { id: "d1", title: "Veille", date: "", source: "digest", tags: [] } };
        },
      };
      ctx.provide("task", svc);
    },
  });
}

/** Faux service documents : note les documents montrés. */
function docs(shown: string[]): PluginDef<any> {
  return definePlugin({
    manifest: { id: "docs", version: "0", licence: "MIT", provides: ["documents"] },
    apply(ctx) {
      ctx.provide("documents", {
        save: async () => { throw new Error("pas ici"); },
        show: async (id) => { shown.push(id); return "avatar"; },
        list: async () => [],
        get: async () => undefined,
      });
    },
  });
}

describe("manifeste : tâches", () => {
  it("demande « task » dans provides, et des ids uniques", () => {
    const base = { id: "x", version: "0", licence: "MIT" };
    expect(manifestError({ ...base, tasks: [{ id: "a", label: "A" }] })).toMatch(/task/);
    expect(manifestError({ ...base, provides: ["task"], tasks: [{ id: "a", label: "A" }, { id: "a", label: "B" }] })).toMatch(/même id/);
    expect(manifestError({ ...base, provides: ["task"], tasks: [{ id: "a", label: "A", schedule: { at: "7h30" } }] })).toMatch(/HH:MM/);
    expect(manifestError({ ...base, provides: ["task"], tasks: [{ id: "a", label: "A", schedule: { every: "3h" } }] })).toBeUndefined();
  });
});

describe("registre des tâches", () => {
  it("liste les tâches sans démarrer le plugin, le réveille pour le passage puis le rendort", async () => {
    const j: string[] = [];
    const shown: string[] = [];
    const initiatives: unknown[] = [];
    k = new Kernel({ logger: quiet, plugins: [digest(j), docs(shown)] });
    k.bus.on("initiative", (p) => { initiatives.push(p); });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }, { id: "docs", plugin: "docs" }] });

    expect(k.tasks.list().map((t) => t.key)).toEqual(["veille/quotidienne"]);
    expect(state(k, "veille")).toBe("loaded"); // endormi : personne ne s'en sert
    expect(j).toEqual([]);

    const out = await k.tasks.run("veille/quotidienne", "clock");
    await k.idle();
    expect(out.ok).toBe(true);
    expect(j).toEqual(["start", "run quotidienne clock sans", "stop"]);
    expect(state(k, "veille")).toBe("loaded");
    expect(initiatives).toMatchObject([{ source: "veille/quotidienne", text: "Ta veille est prête.", importance: "normal" }]);
    expect(shown).toEqual(["d1"]);

    // Le 2e passage reçoit la date du 1er.
    await k.tasks.run("veille/quotidienne", "voice");
    expect(j).toContain("run quotidienne voice avec");
    expect(k.tasks.list()[0]!.lastRun).toBeTruthy();
  });

  it("garde la date du dernier passage dans <home>/tasks.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "tasks-"));
    k = new Kernel({ logger: quiet, home, plugins: [digest([])] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    await k.tasks.run("veille/quotidienne", "manual");
    const saved = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(saved["veille/quotidienne"].lastRun).toBeTruthy();
    await k.stopAll();
    // Un nouveau noyau sur le même dossier s'en souvient.
    k = new Kernel({ logger: quiet, home, plugins: [digest([])] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    expect(k.tasks.list()[0]!.lastRun).toBe(saved["veille/quotidienne"].lastRun);
  });

  it("annonce : important → dit, silent → rien ; l'événement task.done et l'audit portent `reason`", async () => {
    let announce: "important" | "silent" | undefined = "important";
    const plugin = definePlugin({
      manifest: { id: "digest", version: "0", licence: "MIT", provides: ["task"], tasks: [{ id: "quotidienne", label: "Veille du jour", schedule: { at: "07:30" } }] },
      apply(ctx) { ctx.provide("task", { run: async () => ({ summary: "Fait.", ...(announce ? { announce } : {}) }) } satisfies TaskService); },
    });
    const audit = new MemoryAudit();
    k = new Kernel({ logger: quiet, audit, plugins: [plugin] });
    const initiatives: { importance: string }[] = [];
    const done: { reason: string; result: { summary: string } }[] = [];
    k.bus.on("initiative", (p) => { initiatives.push(p); });
    k.bus.on("task.done", (p) => { done.push(p); });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    await k.tasks.run("veille/quotidienne", "voice");
    announce = "silent";
    await k.tasks.run("veille/quotidienne", "clock");
    expect(initiatives.map((i) => i.importance)).toEqual(["important"]);
    expect(done.map((d) => [d.reason, d.result.summary])).toEqual([["voice", "Fait."], ["clock", "Fait."]]);
    expect(audit.records.filter((r) => r.kind === "task").map((r) => r.reason)).toEqual(["voice", "clock"]);
  });

  it("refuse un 2e passage pendant le premier", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    k = new Kernel({ logger: quiet, plugins: [digest([], { gate })] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    const first = k.tasks.run("veille/quotidienne", "clock");
    await new Promise((r) => setTimeout(r, 20));
    expect(k.tasks.list()[0]!.running).toBe(true);
    const second = await k.tasks.run("veille/quotidienne", "voice");
    expect(second.ok).toBe(false);
    expect(tr(second.text)).toMatch(/déjà en cours/);
    expect(tr(second.text, "en")).toMatch(/already running/);
    open();
    expect((await first).ok).toBe(true);
  });

  it("un échec est noté, sans date de passage réussi ni annonce", async () => {
    const initiatives: unknown[] = [];
    k = new Kernel({ logger: quiet, plugins: [digest([], { fail: true })] });
    k.bus.on("initiative", (p) => { initiatives.push(p); });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    const out = await k.tasks.run("veille/quotidienne", "clock");
    expect(out.ok).toBe(false);
    expect(tr(out.text)).toMatch(/source en panne/);
    expect(tr(out.text, "en")).toMatch(/failed: .*source en panne/);
    expect(k.tasks.list()[0]!.lastRun).toBeUndefined();
    expect(k.tasks.list()[0]!.last?.ok).toBe(false);
    expect(initiatives).toEqual([]);
  });

  it("une entrée désactivée n'a plus de tâche ; les outils suivent la liste", async () => {
    k = new Kernel({ logger: quiet, plugins: [digest([])] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }] });
    expect(k.tools.list().map((t) => t.name)).toEqual(expect.arrayContaining(["taches", "lancer_tache"]));
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest", disabled: true }] });
    expect(k.tasks.list()).toEqual([]);
    expect(k.tools.list().map((t) => t.name)).not.toContain("lancer_tache");
  });

  it("lancer_tache (voix) lance en arrière-plan, par le nom de la tâche", async () => {
    const j: string[] = [];
    k = new Kernel({ logger: quiet, plugins: [digest(j)] });
    await k.applyConfig({ plugins: [{ id: "veille", plugin: "digest" }], approvals: { write: "always" } });
    const r = await k.tools.call("lancer_tache", { tache: "veille du jour" });
    expect(r.status).toBe("done");
    expect(r.text).toMatch(/lancée/);
    await new Promise((res) => setTimeout(res, 50));
    await k.idle();
    expect(j).toContain("run quotidienne voice sans");
  });
});

describe("ctx.borrow", () => {
  /** Fournisseur de « completion » élément par élément ; note les démarrages. */
  function models(j: string[]): PluginDef<any> {
    return definePlugin({
      manifest: { id: "models", version: "0", licence: "MIT", provides: ["completion"] },
      apply(ctx) {
        ctx.offer("completion", {
          items: () => [{ id: "sonnet", label: "Sonnet" }],
          start(f, item) {
            j.push(`spawn ${item}`);
            f.effect(() => { j.push(`kill ${item}`); });
            f.provide("completion", { complete: async (r) => ({ text: `ok:${r.prompt}` }) });
          },
        });
      },
    });
  }

  it("démarre l'élément du slot le temps du travail, puis l'arrête", async () => {
    const j: string[] = [];
    let ctxRef: Context | undefined;
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "watch.triage", service: "completion", section: "watch", label: "Tri", none: "Aucun" }] },
      apply(ctx) { ctxRef = ctx; },
    });
    k = new Kernel({ logger: quiet, plugins: [models(j), user] });
    await k.applyConfig({ plugins: [{ id: "m", plugin: "models" }, { id: "u", plugin: "user" }], slots: { "watch.triage": "m/sonnet" } });
    expect(j).toEqual([]); // le slot n'est pas lu pendant apply : rien ne tourne

    const b = await ctxRef!.borrow<{ complete(r: { system: string; prompt: string }): Promise<{ text: string }> }>("watch.triage");
    expect(j).toEqual(["spawn sonnet"]);
    expect((await b!.service.complete({ system: "", prompt: "x" })).text).toBe("ok:x");
    b!.release();
    await k.idle();
    await k.idle();
    expect(j).toEqual(["spawn sonnet", "kill sonnet"]);
  });

  it("rend undefined pour « aucun », et refuse un slot d'un autre plugin", async () => {
    let ctxRef: Context | undefined;
    const user = definePlugin({
      manifest: { id: "user", version: "0", licence: "MIT", slots: [{ id: "watch.triage", service: "completion", section: "watch", label: "Tri", none: "Aucun" }] },
      apply(ctx) { ctxRef = ctx; },
    });
    k = new Kernel({ logger: quiet, plugins: [models([]), user] });
    await k.applyConfig({ plugins: [{ id: "m", plugin: "models" }, { id: "u", plugin: "user" }], slots: { "watch.triage": "@none" } });
    expect(await ctxRef!.borrow("watch.triage")).toBeUndefined();
    expect(() => ctxRef!.borrow("brain.main")).toThrow(/non déclaré/);
  });
});

describe("tâche qui ignore l'arrêt", () => {
  it("n'est plus attendue peu après l'arrêt : elle ne reste pas « en cours »", async () => {
    const j: string[] = [];
    k = new Kernel({ logger: quiet, plugins: [digest(j, { gate: new Promise(() => {}) })] });
    k.tasks.abortGraceMs = 20;
    await k.applyConfig({ plugins: [{ id: "digest", plugin: "digest" }] });
    const run = k.tasks.run("digest/quotidienne", "manual");
    await new Promise((r) => setTimeout(r, 20));
    expect(k.tasks.cancel("digest/quotidienne")).toBe(true);
    const out = await run;
    expect(out.ok).toBe(false);
    expect(tr(out.text, "fr")).toMatch(/arrêtée/);
    expect(k.tasks.list().find((t) => t.key === "digest/quotidienne")?.running).toBeFalsy();
  });
});
