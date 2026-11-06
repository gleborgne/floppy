import { describe, it, expect } from "vitest";
import { Kernel, definePlugin, execAllowed, programName, type Context, type PluginDef } from "../src/index.ts";
import { FileAudit } from "../src/audit.ts";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quiet = () => {};
const node = process.execPath;

function spy(id: string, extra: Record<string, unknown> = {}, onApply?: (ctx: Context) => void | Promise<void>) {
  const box: { ctx?: Context } = {};
  const def = definePlugin({
    manifest: { id, version: "0", licence: "MIT", ...extra } as PluginDef["manifest"],
    async apply(ctx) { box.ctx = ctx; await onApply?.(ctx); },
  });
  return { box, def };
}

describe("permissions.exec", () => {
  it("programName et execAllowed : sans extension, insensible à la casse, * = tout", () => {
    expect(programName("C:\\x\\Llama-Server.EXE")).toBe("llama-server");
    expect(programName("/usr/bin/python")).toBe("python");
    expect(execAllowed({ exec: ["python"] }, "C:\\py\\python.exe")).toBe(true);
    expect(execAllowed({ exec: ["python"] }, "node")).toBe(false);
    expect(execAllowed({ exec: ["*"] }, "n'importe quoi")).toBe(true);
    expect(execAllowed(undefined, "node")).toBe(false);
  });

  it("ctx.spawn refuse un programme non déclaré, accepte un programme déclaré", async () => {
    const no = spy("sans-exec");
    const yes = spy("avec-exec", { permissions: { exec: ["node"] } });
    const any = spy("tout-exec", { permissions: { exec: ["*"] } });
    const k = new Kernel({ logger: quiet, plugins: [no.def, yes.def, any.def] });
    await k.applyConfig({ plugins: [{ id: "a", plugin: "sans-exec" }, { id: "b", plugin: "avec-exec" }, { id: "c", plugin: "tout-exec" }] });
    expect(() => no.box.ctx!.spawn(node, ["-e", "0"])).toThrow(/permissions\.exec/);
    const p = yes.box.ctx!.spawn(node, ["-e", "0"]);
    expect(p.pid).toBeTypeOf("number");
    expect(() => yes.box.ctx!.spawn("python", ["-V"])).toThrow(/permissions\.exec/);
    any.box.ctx!.spawn(node, ["-e", "0"]);
    await k.stopAll();
  });
});

describe("manifeste invalide", () => {
  it("entrée en erreur visible, sans plantage ; les autres plugins démarrent", async () => {
    const bads = [
      { id: "sans-licence", version: "1" },
      { id: "perm-cassee", version: "1", licence: "MIT", permissions: { exec: "node" } },
      { id: "perm-inconnue", version: "1", licence: "MIT", permissions: { root: true } },
      { id: "provides-casse", version: "1", licence: "MIT", provides: "x" },
      { id: "Mauvais Id", version: "1", licence: "MIT" },
    ];
    const defs = bads.map((m) => ({ manifest: m, apply() {} }) as unknown as PluginDef);
    const ok = spy("bon");
    const k = new Kernel({ logger: quiet, plugins: [...defs, ok.def] });
    await k.applyConfig({ plugins: [...bads.map((m, i) => ({ id: "e" + i, plugin: m.id })), { id: "ok", plugin: "bon" }] });
    const st = k.status();
    for (const s of st.slice(0, 5)) { expect(s.state).toBe("error"); expect(s.error).toMatch(/manifeste invalide/); }
    expect(st.at(-1)?.state).toBe("active");
  });

  it("replacePlugin avec un manifeste invalide : l'entrée passe en erreur", async () => {
    const ok = spy("p");
    const k = new Kernel({ logger: quiet, plugins: [ok.def] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await k.replacePlugin({ manifest: { id: "p", version: "1" }, apply() {} } as unknown as PluginDef);
    expect(k.status()[0]).toMatchObject({ state: "error", error: expect.stringMatching(/licence/) });
  });
});

describe("cycle de vie : ctx.fail, provide tardif, notes", () => {
  it("4a. ctx.fail pendant apply : une seule émission d'erreur", async () => {
    const p = spy("p", {}, (ctx) => { ctx.fail("raison"); });
    const k = new Kernel({ logger: quiet, plugins: [p.def] });
    const errs: string[] = [];
    k.bus.on("plugin.state", (s) => { if (s.state === "error") errs.push(s.error ?? ""); });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    await k.idle();
    expect(errs).toEqual(["raison"]);
    expect(k.status()[0]).toMatchObject({ state: "error", error: "raison" });
  });

  it("4a. ctx.fail puis exception dans apply : une seule erreur, la raison du fail", async () => {
    const p = spy("p", {}, (ctx) => { ctx.fail("raison"); throw new Error("autre"); });
    const k = new Kernel({ logger: quiet, plugins: [p.def] });
    const errs: string[] = [];
    k.bus.on("plugin.state", (s) => { if (s.state === "error") errs.push(s.error ?? ""); });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(errs).toEqual(["raison"]);
  });

  it("4b. ctx.provide après apply lève une erreur et n'est pas visible", async () => {
    const p = spy("p", { provides: ["a", "b"] }, (ctx) => { ctx.provide("a", 1); });
    const k = new Kernel({ logger: quiet, plugins: [p.def] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(() => p.box.ctx!.provide("b", 2)).toThrow(/après la fin de apply/);
    expect(k.service("b")).toBeUndefined();
    expect(k.service("a")).toBe(1);
  });

  it("4c. la note d'état disparaît au déchargement", async () => {
    const p = spy("p", {}, (ctx) => { ctx.items.status({ fr: "ok", en: "ok" }); });
    const k = new Kernel({ logger: quiet, plugins: [p.def] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    const notes = () => (k as unknown as { notes: Map<string, unknown> }).notes;
    expect(notes().has("p")).toBe(true);
    await k.stopAll();
    expect(notes().has("p")).toBe(false);
  });
});

describe("règles du cycle de vie", () => {
  it("règle 2 : un service est invisible pendant apply de son fournisseur", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seen: unknown = "pas lu";
    let k!: Kernel;
    const a = spy("pa", { provides: ["a"] }, async (ctx) => { ctx.provide("a", 42); seen = k.service("a"); await gate; });
    k = new Kernel({ logger: quiet, plugins: [a.def] });
    const done = k.applyConfig({ plugins: [{ id: "a", plugin: "pa" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toBeUndefined();
    expect(k.status()[0]?.state).toBe("starting");
    release();
    await done;
    expect(k.service("a")).toBe(42);
  });

  it("règle 7 : les opérations concurrentes sont sérialisées", async () => {
    const journal: string[] = [];
    const slow = (id: string) => spy(id, {}, async () => {
      journal.push(`debut ${id}`);
      await new Promise((r) => setTimeout(r, 40));
      journal.push(`fin ${id}`);
    }).def;
    const k = new Kernel({ logger: quiet, plugins: [slow("x"), slow("y")] });
    await Promise.all([
      k.applyConfig({ plugins: [{ id: "x", plugin: "x" }] }),
      k.applyConfig({ plugins: [{ id: "x", plugin: "x" }, { id: "y", plugin: "y" }] }),
      k.restart("x"),
    ]);
    // Jamais deux apply imbriqués : chaque « debut » est suivi de sa « fin ».
    for (let i = 0; i < journal.length; i += 2) {
      expect(journal[i]).toMatch(/^debut /);
      expect(journal[i + 1]).toBe(journal[i]!.replace("debut", "fin"));
    }
    expect(journal.length).toBeGreaterThanOrEqual(6);
  });
});

describe("audit.tail", () => {
  it("4f. ignore une ligne abîmée", () => {
    const f = join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl");
    const a = new FileAudit(f);
    a.write({ kind: "un" });
    appendFileSync(f, '{"kind":"cass\n');
    a.write({ kind: "trois" });
    expect(a.tail().map((r) => r.kind)).toEqual(["un", "trois"]);
    writeFileSync(f, "pas du json\n");
    expect(a.tail()).toEqual([]);
  });
});
