import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, definePlugin } from "@floppy/core";
import { CONTRACTS, WIKI_DIR, createWiki, extractInterface } from "../src/plugins/wiki.ts";
import { loadPluginDir } from "../src/user-plugins.ts";

const kernels: Kernel[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Un noyau avec un plugin qui fournit « documents » et un outil. */
async function kernel(): Promise<Kernel> {
  const home = mkdtempSync(join(tmpdir(), "floppy-wiki-"));
  dirs.push(home);
  const docs = definePlugin({
    manifest: { id: "docs-test", version: "0.1.0", licence: "MIT", provides: ["documents"] },
    apply(ctx) {
      ctx.provide("documents", { save: async () => ({ id: "1", title: "", date: "", source: "", tags: [] }), show: async () => undefined, list: async () => [], get: async () => undefined });
      ctx.tools.register([{ name: "docs_lire", description: "lire", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => ({ status: "done", text: "" }) }]);
    },
  });
  const k = new Kernel({ home, logger: () => {}, secrets: new MemorySecrets(), plugins: [docs] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "mes-docs", plugin: "docs-test", config: {} }] });
  return k;
}

describe("extractInterface", () => {
  const src = [
    "/** Pas collé : ignoré. */",
    "",
    "const x = 1;",
    "/** Le message. */",
    "export interface A {",
    "  b: { c: string };",
    "  d(): void;",
    "}",
    "export interface B { e: number }",
  ].join("\n");

  it("rend le bloc complet, accolades imbriquées comprises, avec le commentaire collé au-dessus", () => {
    expect(extractInterface(src, "A")).toBe("/** Le message. */\nexport interface A {\n  b: { c: string };\n  d(): void;\n}");
    expect(extractInterface(src, "B")).toBe("export interface B { e: number }");
  });

  it("undefined pour une interface absente ; un nom plus long ne compte pas", () => {
    expect(extractInterface(src, "Z")).toBeUndefined();
    expect(extractInterface("export interface AB {}", "A")).toBeUndefined();
  });
});

describe("wiki des plugins", () => {
  it("chaque page écrite a un titre et un résumé ; le sommaire commence par « basics »", async () => {
    for (const f of readdirSync(WIKI_DIR).filter((x) => x.endsWith(".md"))) {
      const lines = readFileSync(join(WIKI_DIR, f), "utf8").split(/\r?\n/);
      expect(lines[0], f).toMatch(/^# \S/);
      expect(lines[1], f).toMatch(/^> \S/);
    }
    const w = createWiki({ kernel: await kernel(), manifests: () => [] });
    const ids = w.pages().map((p) => p.id);
    expect(ids[0]).toBe("basics");
    expect(ids).toEqual(expect.arrayContaining(["services", "contract-notify", "contract-completion", "active-services", "existing-tools", "example-minuteur", "example-meteo"]));
    expect(w.index()).toContain("- basics: Plugin basics — ");
  });

  it("les contrats sont lus dans le code du noyau : aucune interface manquante", async () => {
    const w = createWiki({ kernel: await kernel(), manifests: () => [] });
    for (const s of Object.keys(CONTRACTS)) {
      const page = w.read(`contract-${s}`)!;
      expect(page, s).not.toContain("not found");
      for (const n of CONTRACTS[s]!) expect(page).toContain(`export interface ${n}`);
    }
    expect(w.read("contract-notify")).toContain("send(msg: NotifyMessage");
    expect(w.read("contract-unknown")).toBeUndefined();
  });

  it("pages calculées : services en marche (manifeste ou état) et outils existants", async () => {
    const k = await kernel();
    const w = createWiki({ kernel: k, manifests: () => [] });
    const services = w.read("active-services")!;
    expect(services).toContain("- documents: mes-docs (active)");
    expect(services).toContain("- notify: no installed plugin provides it");
    // Un plugin qui offre élément par élément n'a rien dans « provided » : le manifeste livré le dit.
    const w2 = createWiki({ kernel: k, manifests: () => [{ id: "docs-test", version: "0.1.0", licence: "MIT", provides: ["documents", "notify"] }] });
    expect(w2.read("active-services")).toContain("- notify: mes-docs (active)");
    expect(w.read("existing-tools")).toContain("- docs_lire [read]");
  });

  it("exemples : le code complet, index.ts d'abord", async () => {
    const page = createWiki({ kernel: await kernel(), manifests: () => [] }).read("example-meteo")!;
    expect(page.indexOf("## index.ts")).toBeGreaterThan(0);
    expect(page.indexOf("## index.ts")).toBeLessThan(page.indexOf("## codes.ts"));
    expect(page).toContain("## floppy-plugin.json");
  });

  it("outil doc_plugins : sommaire, page (nom souple), page inconnue, recherche", async () => {
    const { tool } = createWiki({ kernel: await kernel(), manifests: () => [] });
    expect(tool.level).toBe("read");
    expect((await tool.handler({}, {})).text).toContain("# Floppy plugin wiki");
    expect((await tool.handler({ page: " Services.md " }, {})).text).toContain("# Using Floppy's services");
    const unknown = await tool.handler({ page: "nope" }, {});
    expect(unknown.status).toBe("failed");
    expect(unknown.text).toContain("basics");
    const found = String((await tool.handler({ search: "borrowItem release" }, {})).text);
    expect(found).toMatch(/result\(s\) for "borrowItem release"/);
    expect(found).toContain("services:");
    expect((await tool.handler({ search: "zzznotthere" }, {})).text).toContain("Nothing for");
  });

  it("la recette « envoyer un message » de la page services marche dans un plugin personnel", async () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-wiki-recette-"));
    dirs.push(home);
    // Un canal « notify » offert élément par élément, comme Telegram.
    const sent: string[] = [];
    const canal = definePlugin({
      manifest: { id: "canal-test", version: "0.1.0", licence: "MIT", provides: ["notify"] },
      apply(ctx) {
        ctx.offer("notify", {
          items: () => [{ id: "perso", label: "Canal · perso" }],
          start(f) { f.provide("notify", { label: "Canal · perso", send: async (m) => { sent.push(`${m.title}: ${m.markdown}`); } }); },
        });
      },
    });
    // Le plugin personnel suit la page services mot pour mot (optional, offers, borrowItem, release).
    const dir = join(home, "plugins", "eau");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), `
import type { UserPlugin } from "../floppy-plugin.d.ts";
const plugin: UserPlugin = {
  manifest: { id: "eau", version: "0.1.0", licence: "MIT", description: { fr: "Eau", en: "Water" }, optional: ["notify"] },
  apply(ctx) {
    ctx.tools.register([{ name: "eau_envoyer", description: "envoie", inputSchema: { type: "object", properties: {} }, level: "send",
      async handler() {
        const canaux = ctx.offers("notify");
        if (!canaux.length) return { status: "failed", text: { fr: "Aucun canal d'envoi.", en: "No sending channel." } };
        const b = await ctx.borrowItem("notify", canaux[0].value);
        if (!b) return { status: "failed", text: { fr: "Canal indisponible.", en: "Channel unavailable." } };
        try { await b.service.send({ title: "Rappel", markdown: "Boire un verre d'eau." }); }
        finally { b.release(); }
        return { status: "done", text: { fr: "Envoyé sur " + canaux[0].label, en: "Sent" } };
      } }]);
  },
};
export default plugin;
`);
    const { def } = await loadPluginDir(dir);
    const k = new Kernel({ home, logger: () => {}, secrets: new MemorySecrets(), plugins: [canal, def] });
    kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "canal", plugin: "canal-test", config: {} }, { id: "u-eau", plugin: "eau", config: {} }], approvals: { send: "always" } });
    expect(await k.tools.call("eau_envoyer", {})).toMatchObject({ status: "done", text: "Envoyé sur Canal · perso" });
    expect(sent).toEqual(["Rappel: Boire un verre d'eau."]);
  });
});
