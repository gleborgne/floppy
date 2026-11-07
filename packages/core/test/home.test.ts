// Répertoire de travail : dossier par défaut, dossier choisi (pointeur), déplacement des données, config, réglage.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMove, chooseHome, defaultConfigPath, defaultHome, floppyHome, Kernel, tr, errorText } from "../src/index.ts";

/** Un faux système : LOCALAPPDATA dans un dossier temporaire. */
function sys() {
  const root = mkdtempSync(join(tmpdir(), "floppy-home-"));
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: join(root, "local") };
  return { root, env, def: join(root, "local", "floppy") };
}

describe("répertoire de travail", () => {
  it("par défaut : <LOCALAPPDATA>/floppy ; FLOPPY_HOME passe avant tout", () => {
    const { env, def, root } = sys();
    expect(defaultHome(env)).toBe(def);
    expect(floppyHome(env)).toBe(def);
    expect(floppyHome({ ...env, FLOPPY_HOME: join(root, "forcé") })).toBe(join(root, "forcé"));
  });

  it("choisir un dossier vide : les données y sont déplacées au démarrage suivant, le pointeur reste en place", () => {
    const { env, def, root } = sys();
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, "settings.json"), '{"a":1}');
    mkdirSync(join(def, "models"));
    writeFileSync(join(def, "models", "m.gguf"), "x");
    const target = join(root, "D", "Floppy");
    expect(chooseHome(target, env)).toBe("move");
    expect(floppyHome(env)).toBe(target);
    const moved = applyPendingMove(() => {}, env);
    expect(moved.sort()).toEqual(["models", "settings.json"]);
    expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"a":1}');
    expect(existsSync(join(target, "models", "m.gguf"))).toBe(true);
    expect(existsSync(join(def, "settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(def, "home.json"), "utf8"))).toEqual({ home: target });
    expect(applyPendingMove(() => {}, env)).toEqual([]); // une seule fois
  });

  it("choisir un dossier qui a déjà des données de Floppy : il est repris tel quel", () => {
    const { env, def, root } = sys();
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, "settings.json"), '{"ancien":1}');
    const target = join(root, "autre");
    mkdirSync(target);
    writeFileSync(join(target, "settings.json"), '{"repris":1}');
    expect(chooseHome(target, env)).toBe("use");
    expect(applyPendingMove(() => {}, env)).toEqual([]);
    expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"repris":1}');
    expect(readFileSync(join(def, "settings.json"), "utf8")).toBe('{"ancien":1}');
  });

  it("refuse un chemin relatif, un dossier dans l'autre, et rien ne change pour le même dossier", () => {
    const { env, def } = sys();
    expect(() => chooseHome("Floppy", env)).toThrow();
    expect(() => chooseHome(join(def, "sous"), env)).toThrow();
    expect(chooseHome(def, env)).toBe("same");
    expect(() => chooseHome("D:/x", { ...env, FLOPPY_HOME: def })).toThrow(/FLOPPY_HOME/);
  });

  it("revenir au dossier par défaut : le pointeur ne garde plus de dossier choisi", () => {
    const { env, def, root } = sys();
    const target = join(root, "D");
    expect(chooseHome(target, env)).toBe("move");
    applyPendingMove(() => {}, env);
    writeFileSync(join(target, "settings.json"), "{}");
    expect(chooseHome(def, env)).toBe("move");
    applyPendingMove(() => {}, env);
    expect(floppyHome(env)).toBe(def);
    expect(existsSync(join(def, "settings.json"))).toBe(true);
  });

  it("config : <dossier>/floppy.yml ; une ancienne config est copiée une fois, l'originale reste", () => {
    const { root } = sys();
    const home = join(root, "h");
    mkdirSync(home);
    const legacy = join(root, "repo", "floppy.yml");
    mkdirSync(join(root, "repo"));
    writeFileSync(legacy, "plugins: []\n");
    const logs: string[] = [];
    expect(defaultConfigPath(home, [legacy], (m) => logs.push(m))).toBe(join(home, "floppy.yml"));
    expect(readFileSync(join(home, "floppy.yml"), "utf8")).toBe("plugins: []\n");
    expect(existsSync(legacy)).toBe(true);
    writeFileSync(legacy, "changé\n");
    defaultConfigPath(home, [legacy]);
    expect(readFileSync(join(home, "floppy.yml"), "utf8")).toBe("plugins: []\n");
    expect(logs).toHaveLength(1);
  });
});

describe("réglage « répertoire de travail »", () => {
  const saved = process.env.LOCALAPPDATA;
  afterEach(() => { if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved; });

  it("rend le dossier en usage, et le changer demande à l'hôte de relancer le noyau", async () => {
    const { env, root } = sys();
    process.env.LOCALAPPDATA = env.LOCALAPPDATA;
    const home = floppyHome(env);
    const k = new Kernel({ logger: () => {}, home });
    await k.applyConfig({ plugins: [] });
    const info = k.settings.list().find((s) => s.key === "dossier_floppy");
    expect(info).toMatchObject({ value: home, folder: true, risk: "cli" });
    const restart = new Promise((r) => k.bus.on("floppy.restart", r));
    const r = await k.settings.change("dossier_floppy", join(root, "nouveau"), "ui");
    expect(r.ok).toBe(true);
    await restart;
    expect(floppyHome(env)).toBe(join(root, "nouveau"));
    const bad = await k.settings.change("dossier_floppy", "relatif", "ui");
    expect(bad.ok).toBe(false);
    expect(tr(errorText(bad.text), "fr")).toMatch(/chemin complet/);
    await k.stopAll();
  });
});
