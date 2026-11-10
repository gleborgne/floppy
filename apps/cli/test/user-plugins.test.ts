import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, tr, type PluginDef } from "@floppy/core";
import { createUserPlugins, type UserPlugins } from "../src/user-plugins.ts";

const quiet = () => {};
const homes: string[] = [];
const kernels: Kernel[] = [];

/** Source d'un plugin utilisateur : un outil `hello_<id>` qui répond `msg`. */
function src(id: string, msg: string, extra = ""): string {
  return `import type { PluginDef } from "../floppy-plugin.d.ts";
const plugin = {
  manifest: { id: "${id}", version: "1.0.0", licence: "MIT", description: "Plugin d'essai." ${extra} },
  apply(ctx: any) {
    ctx.log("info", "salut");
    ctx.tools.register([{ name: "hello_${id.replaceAll("-", "_")}", description: "d", inputSchema: { type: "object", properties: {} }, level: "read",
      handler: async () => ({ status: "done", text: "${msg}" }) }]);
  },
};
export default plugin;
`;
}

function setup(files: Record<string, string>): { home: string; kernel: Kernel; up: UserPlugins } {
  const home = mkdtempSync(join(tmpdir(), "assistant-userplug-"));
  homes.push(home);
  mkdirSync(join(home, "plugins"), { recursive: true });
  for (const [id, code] of Object.entries(files)) {
    mkdirSync(join(home, "plugins", id), { recursive: true });
    writeFileSync(join(home, "plugins", id, "index.ts"), code);
  }
  // Fichiers et dossiers à ignorer.
  writeFileSync(join(home, "plugins", "floppy-plugin.d.ts"), "export {};\n");
  writeFileSync(join(home, "plugins", "AGENTS.md"), "# doc\n");
  mkdirSync(join(home, "plugins", "vide"), { recursive: true });
  const builtin: PluginDef<any>[] = [{ manifest: { id: "interne", version: "0", licence: "MIT" }, apply() {} }];
  const kernel = new Kernel({ home, logger: quiet, plugins: builtin });
  kernels.push(kernel);
  const up = createUserPlugins(kernel, { builtin: ["interne"], logger: quiet });
  return { home, kernel, up };
}

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stopAll();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("plugins utilisateur", () => {
  it("trouve, enregistre, déclare un réglage ; ui l'active, voice est refusé", async () => {
    const { kernel, up } = setup({ "mon-plugin": src("mon-plugin", "v1") });
    await kernel.applyConfig({ plugins: [], approvals: { write: "always" } });
    const rep = await up.reload();
    expect(rep).toEqual([{ id: "mon-plugin", status: "ajouté" }]); // ni fichiers racine ni dossier vide
    const s = kernel.settings.list().find((x) => x.key === "plugin_mon_plugin")!;
    expect(s).toMatchObject({ label: { fr: "Plugin « mon-plugin »", en: 'Plugin "mon-plugin"' }, group: { fr: "Plugins utilisateur", en: "User plugins" }, type: "boolean", value: false, risk: "cli" });
    expect(tr(s.description)).toContain("chargé");
    expect(tr(s.description, "en")).toContain("User plugin, unverified code");

    const refused = await kernel.settings.change("plugin_mon_plugin", true, "voice");
    expect(refused.ok).toBe(false);
    expect(kernel.status().find((e) => e.id === "u-mon-plugin")).toBeUndefined();

    expect((await kernel.settings.change("plugin_mon_plugin", true, "ui")).ok).toBe(true);
    expect(kernel.status().find((e) => e.id === "u-mon-plugin")?.state).toBe("active");
    expect((await kernel.tools.call("hello_mon_plugin", {})).text).toBe("v1");

    // La config du fichier garde l'entrée.
    await kernel.applyConfig({ plugins: [] });
    expect(kernel.status().find((e) => e.id === "u-mon-plugin")?.state).toBe("active");

    expect((await kernel.settings.change("plugin_mon_plugin", false, "ui")).ok).toBe(true);
    expect(kernel.status().find((e) => e.id === "u-mon-plugin")).toBeUndefined();
  });

  it("l'activation est gardée : un nouveau noyau démarre le plugin au premier chargement", async () => {
    const { home, kernel, up } = setup({ "mon-plugin": src("mon-plugin", "v1") });
    await up.reload();
    await kernel.settings.change("plugin_mon_plugin", true, "ui");
    const k2 = new Kernel({ home, logger: quiet });
    kernels.push(k2);
    const up2 = createUserPlugins(k2, { builtin: [], logger: quiet });
    await up2.reload();
    await k2.applyConfig({ plugins: [] });
    expect(k2.status().find((e) => e.id === "u-mon-plugin")?.state).toBe("active");
  });

  it("modifier le fichier puis recharger redémarre le plugin avec le nouveau code", async () => {
    const { home, kernel, up } = setup({ "mon-plugin": src("mon-plugin", "v1") });
    await kernel.applyConfig({ plugins: [], approvals: { write: "always" } });
    await up.reload();
    await kernel.settings.change("plugin_mon_plugin", true, "ui");
    expect((await up.reload())[0]).toMatchObject({ status: "inchangé" });
    writeFileSync(join(home, "plugins", "mon-plugin", "index.ts"), src("mon-plugin", "version deux"));
    expect(await up.reload()).toEqual([{ id: "mon-plugin", status: "rechargé" }]);
    expect(kernel.status().find((e) => e.id === "u-mon-plugin")?.state).toBe("active");
    expect((await kernel.tools.call("hello_mon_plugin", {})).text).toBe("version deux");
  });

  it("un plugin personnel a ses propres noms de service, de hook et d'événement (augmentation de module du SDK)", async () => {
    const code = `import type { PluginContext } from "../floppy-plugin.d.ts";
declare module "../floppy-plugin.d.ts" {
  interface Services { "perso.compteur": { suivant(): number } }
  interface HookTypes { "perso.avant": { input: { n: number }; output: string } }
  interface BusEvents { "perso.tic": { fois: number } }
}
export default {
  manifest: { id: "perso", version: "1.0.0", licence: "MIT", provides: ["perso.compteur"] },
  apply(ctx: PluginContext) {
    let n = 0;
    const tics: number[] = [];
    ctx.provide("perso.compteur", { suivant: () => ++n });
    ctx.hook("perso.avant", async (input, next) => next({ n: input.n + 1 }));
    ctx.on("perso.tic", (p) => { tics.push(p.fois); });
    ctx.tools.register([{ name: "essai_perso", description: "d", inputSchema: { type: "object", properties: {} }, level: "read",
      handler: async () => {
        const r = await ctx.runHook("perso.avant", { n: 1 }, async (i) => "n=" + i.n);
        ctx.emit("perso.tic", { fois: 2 });
        return { status: "done", text: r + " tics=" + tics.join(",") + " svc=" + (await Promise.resolve(n)) };
      } }]);
  },
};
`;
    const { kernel, up } = setup({ perso: code });
    await kernel.applyConfig({ plugins: [] });
    expect(await up.reload()).toEqual([{ id: "perso", status: "ajouté" }]);
    expect((await kernel.settings.change("plugin_perso", true, "ui")).ok).toBe(true);
    expect(kernel.status().find((e) => e.id === "u-perso")?.state).toBe("active");
    expect((await kernel.tools.call("essai_perso", {})).text).toBe("n=2 tics=2 svc=0");
  });

  it("un plugin cassé signale son erreur sans gêner les autres", async () => {
    const { kernel, up } = setup({
      "bon": src("bon", "ok"),
      "syntaxe": "export default { manifest: ;;; ",
      "mauvais-id": src("autre-nom", "x"),
      "interne": src("interne", "x"),
      "faute": src("faute", "x", `, optionnal: ["memory"]`),
      "sans-apply": `export default { manifest: { id: "sans-apply", version: "1", licence: "MIT" } };\n`,
    });
    await kernel.applyConfig({ plugins: [] });
    const rep = await up.reload();
    const by = Object.fromEntries(rep.map((r) => [r.id, r]));
    expect(by["bon"]?.status).toBe("ajouté");
    expect(by["syntaxe"]?.status).toBe("erreur");
    expect(by["mauvais-id"]?.error).toContain("nom du dossier");
    expect(by["interne"]?.error).toContain("livré avec l'app");
    expect(by["sans-apply"]?.error).toContain("apply");
    expect(by["faute"]).toMatchObject({ status: "erreur", error: expect.stringContaining("optionnal : champ inconnu (voulais-tu « optional » ?)") });
    expect((await kernel.settings.change("plugin_syntaxe", true, "ui")).ok).toBe(false); // activation impossible
    expect((await kernel.settings.change("plugin_bon", true, "ui")).ok).toBe(true);
    expect(kernel.status().find((e) => e.id === "u-bon")?.state).toBe("active");
    const etat = await kernel.tools.call("plugin_status", {});
    expect(etat.text).toContain("syntaxe : erreur");
    expect(etat.text).toContain("bon : chargé ; activé");
  });

  it("reload_plugins et test_plugin passent par le noyau (niveau write)", async () => {
    const { kernel } = setup({ "bon": src("bon", "ok") });
    const levels = Object.fromEntries(kernel.tools.list().map((t) => [t.name, t.level]));
    expect(levels).toMatchObject({ plugin_status: "read", reload_plugins: "write", test_plugin: "write" });
    await kernel.applyConfig({ plugins: [], approvals: { write: "always" } });
    expect((await kernel.tools.call("reload_plugins", {})).text).toBe("bon : ajouté");
    expect(kernel.tools.list().map((t) => t.name).filter((n) => ["etat_plugins", "recharger_plugins", "tester_plugin"].includes(n))).toEqual([]); // les anciens noms français n'existent plus
  });

  it("test_plugin rapporte outils, journal et erreurs sans toucher au noyau", async () => {
    const { kernel } = setup({
      "bon": src("bon", "ok", `, inject: ["absent"]`),
      "libre": src("libre", "ok"),
      "plante": `export default { manifest: { id: "plante", version: "1", licence: "MIT" }, apply() { throw new Error("boum"); } };\n`,
      "casse": "export default {{{",
    });
    await kernel.applyConfig({ plugins: [], approvals: { write: "always" } });
    const libre = await kernel.tools.call("test_plugin", { id: "libre" });
    expect(libre.status).toBe("done");
    expect(libre.text).toContain("hello_libre [read]");
    expect(libre.text).toContain("salut");
    const attente = await kernel.tools.call("test_plugin", { id: "bon" });
    expect(attente.text).toContain("Services manquants (attente) : absent");
    const plante = await kernel.tools.call("test_plugin", { id: "plante" });
    expect(plante.status).toBe("failed");
    expect(plante.text).toContain("boum");
    expect((await kernel.tools.call("test_plugin", { id: "casse" })).text).toContain("import impossible");
    expect((await kernel.tools.call("test_plugin", { id: "../x" })).status).toBe("failed");
    // Le vrai noyau n'a rien reçu.
    expect(kernel.tools.has("hello_libre")).toBe(false);
    expect(kernel.status()).toEqual([]);
  });
});

describe("plugins utilisateur : pas de code exécuté au démarrage s'ils sont désactivés", () => {
  it("reload(false) ne lit pas un plugin désactivé ; l'activer le lit et le démarre", async () => {
    const marker = join(tmpdir(), `floppy-marker-${Date.now()}.txt`);
    const code = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "lu");\n` + src("espion", "ok").replace('import type { PluginDef } from "../floppy-plugin.d.ts";\n', "");
    const { kernel, up } = setup({ espion: code });
    await kernel.applyConfig({ plugins: [] });
    const { existsSync } = await import("node:fs");
    await up.reload(false);
    expect(existsSync(marker)).toBe(false);
    const info = kernel.settings.list().find((s) => s.key === "plugin_espion");
    expect(tr(info?.description)).toMatch(/Pas encore lu/);
    expect((await kernel.settings.change("plugin_espion", true, "ui")).ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
    await kernel.idle();
    expect(kernel.status().find((s) => s.id === "u-espion")?.state).toBe("active");
    rmSync(marker, { force: true });
  });
});

describe("plugins utilisateur : droits", () => {
  it("montre les droits déclarés ; refuse permissions.approvals: respond", async () => {
    const { kernel, up } = setup({
      "avec-droits": src("avec-droits", "x", `, permissions: { exec: ["python"], net: ["api.exemple.fr"], cloud: true }`),
      "veut-repondre": src("veut-repondre", "x", `, permissions: { approvals: "respond" }`),
    });
    await kernel.applyConfig({ plugins: [] });
    const rep = await up.reload();
    expect(rep.find((r) => r.id === "veut-repondre")).toMatchObject({ status: "erreur", error: expect.stringContaining("approvals") });
    const s = kernel.settings.list().find((x) => x.key === "plugin_avec_droits")!;
    expect(tr(s.description)).toContain("lance des programmes : python");
    expect(tr(s.description)).toContain("réseau : api.exemple.fr");
    expect(tr(s.description)).toContain("cloud");
    expect(tr(s.description, "en")).toContain("runs programs: python");
    expect(up.list().find((x) => x.id === "avec-droits")?.permissions).toContain("python");
    const r = await kernel.settings.change("plugin_veut_repondre", true, "ui");
    expect(r.ok).toBe(false);
    expect(kernel.status().find((e) => e.id === "u-veut-repondre")).toBeUndefined();
  });
});
