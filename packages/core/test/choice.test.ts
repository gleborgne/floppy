// Choix dans une liste : réponse, option inconnue, délai, annulation, entrée invalide, permissions du ctx.
import { describe, it, expect, vi } from "vitest";
import { Kernel, MemoryAudit, definePlugin, TextError, T, type Context, type PluginDef } from "../src/index.ts";

const quiet = () => {};
const options = [{ id: "a", label: "Alpha", detail: T("détail", "detail") }, { id: "b", label: T("Bravo", "Bravo") }];

function spy(id: string, permissions?: PluginDef["manifest"]["permissions"]) {
  const box: { ctx?: Context } = {};
  const def = definePlugin({
    manifest: { id, version: "0", licence: "MIT", ...(permissions ? { permissions } : {}) },
    apply(ctx) { box.ctx = ctx; },
  });
  return { box, def };
}

describe("Choix dans une liste", () => {
  it("une réponse débloque la demande ; une 2e réponse est ignorée ; le noyau note l'audit", async () => {
    const audit = new MemoryAudit();
    const k = new Kernel({ logger: quiet, audit });
    const closed: unknown[] = [];
    k.bus.on("choice.closed", (c) => closed.push(c));
    k.bus.on("choice.request", (r) => {
      expect(r.options).toEqual([{ id: "a", label: "Alpha", detail: "détail" }, { id: "b", label: "Bravo" }]);
      expect(k.choices.respond(r.id, "b", "avatar")).toBe(true);
      expect(k.choices.respond(r.id, "a", "telegram")).toBe(false);
    });
    const r = await k.choices.ask({ title: "Lequel ?", options, source: "demo", origin: "avatar" });
    expect(r).toEqual({ picked: "b", reason: "user", by: "avatar" });
    expect(closed).toEqual([expect.objectContaining({ picked: "b", reason: "user", by: "avatar" })]);
    expect(audit.records).toEqual([expect.objectContaining({ kind: "choice", source: "demo", origin: "avatar", options: 2, picked: "b", reason: "user", by: "avatar" })]);
  });

  it("une option absente de la liste est refusée, la demande reste ouverte", async () => {
    const k = new Kernel({ logger: quiet });
    const p = k.choices.ask({ title: "?", options });
    const [req] = k.choices.pending();
    expect(k.choices.respond(req!.id, "zzz", "avatar")).toBe(false);
    expect(k.choices.respond("inconnu", "a", "avatar")).toBe(false);
    expect(k.choices.pending()).toHaveLength(1);
    expect(k.choices.respond(req!.id, "a", "avatar")).toBe(true);
    expect((await p).picked).toBe("a");
  });

  it("pas de réponse : timeout après le délai (défaut 60 s, borné 5..600)", async () => {
    vi.useFakeTimers();
    try {
      const k = new Kernel({ logger: quiet });
      const p = k.choices.ask({ title: "?", options });
      expect(k.choices.pending()[0]!.ttl_s).toBe(60);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await p).toEqual({ reason: "timeout" });
      expect(k.choices.pending()).toHaveLength(0);
      void k.choices.ask({ title: "?", options, ttl_s: 1 });
      void k.choices.ask({ title: "?", options, ttl_s: 9999 });
      expect(k.choices.pending().map((r) => r.ttl_s)).toEqual([5, 600]);
      k.choices.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un signal annulé annule la demande, avant ou pendant l'attente", async () => {
    const k = new Kernel({ logger: quiet });
    expect(await k.choices.ask({ title: "?", options, signal: AbortSignal.abort() })).toEqual({ reason: "cancelled" });
    expect(k.choices.pending()).toHaveLength(0);
    const c = new AbortController();
    const p = k.choices.ask({ title: "?", options, signal: c.signal });
    expect(k.choices.pending()).toHaveLength(1);
    c.abort();
    expect(await p).toEqual({ reason: "cancelled" });
    expect(k.choices.pending()).toHaveLength(0);
  });

  it("entrée invalide : moins de 2 ou plus de 20 options, id vide ou en double", () => {
    const k = new Kernel({ logger: quiet });
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: "x" }));
    expect(() => k.choices.ask({ title: "?", options: [{ id: "a", label: "A" }] })).toThrow(TextError);
    expect(() => k.choices.ask({ title: "?", options: many })).toThrow(TextError);
    expect(() => k.choices.ask({ title: "?", options: [{ id: "a", label: "A" }, { id: "", label: "B" }] })).toThrow(TextError);
    expect(() => k.choices.ask({ title: "?", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] })).toThrow(TextError);
    expect(k.choices.pending()).toHaveLength(0);
  });

  it("les textes suivent la langue de l'assistant", async () => {
    const k = new Kernel({ logger: quiet });
    k.choices.lang = () => "en";
    void k.choices.ask({ title: T("Quel ?", "Which?"), options: [{ id: "a", label: T("Un", "One") }, { id: "b", label: "Deux" }] });
    expect(k.choices.pending()[0]).toMatchObject({ title: "Which?", options: [{ id: "a", label: "One" }, { id: "b", label: "Deux" }] });
    k.choices.cancelAll();
  });

  it("cancelAll annule tout ; stopAll aussi", async () => {
    const k = new Kernel({ logger: quiet });
    const a = k.choices.ask({ title: "?", options });
    const b = k.choices.ask({ title: "?", options });
    k.choices.cancelAll();
    expect(await a).toEqual({ reason: "cancelled" });
    expect(await b).toEqual({ reason: "cancelled" });
    const c = k.choices.ask({ title: "?", options });
    await k.stopAll();
    expect(await c).toEqual({ reason: "cancelled" });
  });
});

describe("Choix dans une liste : ctx des plugins", () => {
  it("sans permissions.approvals, ask est permis (source = id) mais respond et pending sont refusés", async () => {
    const s = spy("sans");
    const k = new Kernel({ logger: quiet, plugins: [s.def] });
    await k.applyConfig({ plugins: [{ id: "x", plugin: "sans" }] });
    expect(() => s.box.ctx!.choices.respond("id", "a", "x")).toThrow(/permissions\.approvals/);
    expect(() => s.box.ctx!.choices.pending()).toThrow(/permissions\.approvals/);
    k.bus.on("choice.request", (r) => { expect(r.source).toBe("x"); k.choices.respond(r.id, "a", "avatar"); });
    expect(await s.box.ctx!.choices.ask({ title: "?", options })).toMatchObject({ picked: "a", by: "avatar" });
    await k.stopAll();
  });

  it("avec permissions.approvals: respond, respond et pending sont permis", async () => {
    const s = spy("avec", { approvals: "respond" });
    const k = new Kernel({ logger: quiet, plugins: [s.def] });
    await k.applyConfig({ plugins: [{ id: "x", plugin: "avec" }] });
    const p = s.box.ctx!.choices.ask({ title: "?", options });
    const [req] = s.box.ctx!.choices.pending();
    expect(req).toBeTruthy();
    expect(s.box.ctx!.choices.respond(req!.id, "b", "corps")).toBe(true);
    expect((await p).picked).toBe("b");
    await k.stopAll();
  });

  it("l'arrêt d'un plugin annule son choix en cours ; arrêté, il ne peut plus en ouvrir", async () => {
    const s = spy("p");
    const k = new Kernel({ logger: quiet, plugins: [s.def] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    const ctx = s.box.ctx!;
    const asked = ctx.choices.ask({ title: "?", options });
    expect(k.choices.pending()).toHaveLength(1);
    await k.applyConfig({ plugins: [] });
    expect(await asked).toEqual({ reason: "cancelled" });
    expect(k.choices.pending()).toHaveLength(0);
    expect(await ctx.choices.ask({ title: "?", options })).toEqual({ reason: "cancelled" });
    expect(k.choices.pending()).toHaveLength(0);
    await k.stopAll();
  });
});
