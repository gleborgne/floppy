import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, SectionRegistry, definePlugin, LANGS } from "../src/index.ts";
import * as core from "../src/index.ts";

describe("rubriques de la fenêtre", () => {
  it("fusion : le premier libellé gagne, les champs manquants sont complétés, tri par ordre", () => {
    const r = new SectionRegistry();
    r.declare("a", [{ id: "voice", label: "Voix", order: 20 }, { id: "body", label: "Corps", order: 50 }]);
    r.declare("b", [{ id: "voice", label: { fr: "Autre" }, description: "La voix", icon: "mic", order: 5 }, { id: "listening", label: "Écoute", order: 30 }]);
    const l = r.list();
    expect(l.map((s) => s.id)).toEqual(["voice", "listening", "body"]);
    expect(l[0]).toMatchObject({ label: "Voix", description: "La voix", icon: "mic", order: 20, sources: ["a", "b"] });
  });

  it("retirer la première déclaration : la suivante reprend", () => {
    const r = new SectionRegistry();
    const off = r.declare("a", [{ id: "x", label: "Premier" }]);
    r.declare("b", [{ id: "x", label: "Second", parent: "y" }]);
    expect(r.list()[0]).toMatchObject({ label: "Premier", parent: "y" });
    off();
    expect(r.list()[0]).toMatchObject({ label: "Second", sources: ["b"] });
  });

  it("le noyau déclare general et plugins ; les plugins ajoutent les leurs par leur manifeste", () => {
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT", sections: [{ id: "general", label: "Ignoré" }, { id: "brain", label: "Cerveau", order: 10 }] },
      apply() {},
    });
    const k = new Kernel({ logger: () => {}, plugins: [p], home: mkdtempSync(join(tmpdir(), "sec-")) });
    const l = k.sections.list();
    expect(l.map((s) => s.id)).toEqual(["general", "brain", "plugins"]);
    expect(l[0]!.label).toEqual({ fr: "Général", en: "General" });
  });

  it("ui_language : alias dérivés de LANGS ; sectionOf n'existe plus", () => {
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "sec-")) });
    const s = k.settings.list().find((x) => x.key === "ui_language")!;
    expect(s.options!.map((o) => [o.value, o.aliases])).toEqual(LANGS.map((l) => [l.value, [...l.aliases]]));
    expect((core as Record<string, unknown>).sectionOf).toBeUndefined();
  });
});

describe("rôle des réglages", () => {
  it("byRole retrouve les réglages d'un rôle, sans connaître leur clé", async () => {
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) {
        const base = { description: "", type: "text" as const, risk: "free" as const, section: "brain", get: () => "", set: () => {} };
        ctx.settings.declare([{ ...base, key: "moteur", label: "Moteur", role: "brain.main" }, { ...base, key: "aide", label: "Aide", role: "brain.delegate" }, { ...base, key: "autre", label: "Autre" }]);
      },
    });
    const k = new Kernel({ logger: () => {}, plugins: [p], home: mkdtempSync(join(tmpdir(), "sec-")) });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    expect(k.settings.byRole("brain.main").map((s) => s.key)).toEqual(["moteur"]);
    expect(k.settings.byRole("brain.delegate").map((s) => s.key)).toEqual(["aide"]);
    expect(k.settings.list().find((s) => s.key === "moteur")?.role).toBe("brain.main");
    expect(k.settings.byRole("inconnu")).toEqual([]);
    await k.stopAll();
  });
});

describe("fournisseurs : présentation et capacités", () => {
  it("layout et capabilities passent dans le snapshot (défauts : list, aucune)", async () => {
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) {
        const base = { section: "body", label: "X", list: () => [] };
        ctx.items.declare({ ...base, id: "a", layout: "grid", capabilities: ["live"] });
        ctx.items.declare({ ...base, id: "b" });
      },
    });
    const k = new Kernel({ logger: () => {}, plugins: [p], home: mkdtempSync(join(tmpdir(), "sec-")) });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    const snap = await k.items.snapshot();
    expect(snap.find((x) => x.id === "a")).toMatchObject({ layout: "grid", capabilities: ["live"] });
    expect(snap.find((x) => x.id === "b")).toMatchObject({ layout: "list", capabilities: [] });
    await k.stopAll();
  });
});
