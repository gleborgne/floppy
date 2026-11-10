// Raccourcis clavier réglables (Réglages → Système) : lecture de ce que tape l'utilisateur, refus clairs, conflits.
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import bodyHub from "@floppy/plugin-body-hub";
import { Kernel, TextError, tr } from "@floppy/core";
import electron, { normalizeShortcut, SHORTCUT_DEFAULTS } from "../src/index.ts";

describe("normalizeShortcut", () => {
  it("rend la forme lisible, quelle que soit l'écriture", () => {
    expect(normalizeShortcut("ctrl+alt+f")).toBe("Ctrl+Alt+F");
    expect(normalizeShortcut("Control + Alt + F9")).toBe("Ctrl+Alt+F9");
    expect(normalizeShortcut("alt shift 1")).toBe("Alt+Shift+1");
    expect(normalizeShortcut("shift ctrl space")).toBe("Ctrl+Shift+Space");
    expect(normalizeShortcut("")).toBe("");
  });

  it("refuse une touche seule, une touche inconnue ou deux touches, en français et en anglais", () => {
    for (const bad of ["f", "shift+f", "ctrl+alt+ff", "ctrl+a+b", "ctrl+alt"]) {
      let err: unknown;
      try { normalizeShortcut(bad); } catch (e) { err = e; }
      expect(err, bad).toBeInstanceOf(TextError);
      expect(tr((err as TextError).text, "en")).not.toBe(tr((err as TextError).text, "fr"));
    }
  });
});

// Faux canal de l'app de bureau, donné au noyau (option host) : plus aucun objet global du processus.
const proc: { parentPort?: unknown } = {};

describe("réglages des raccourcis", () => {
  afterEach(() => { delete proc.parentPort; });

  it("un réglage par action dans Système, valeur par défaut, conflit refusé, vide = désactivé", async () => {
    // Le plugin parle au processus principal d'Electron : on le remplace par un faux, qui garde les messages « display ».
    const sent: { type: string; settings?: { shortcuts?: Record<string, string> } }[] = [];
    const parent = Object.assign(new EventEmitter(), { postMessage: (m: unknown) => { sent.push(m as (typeof sent)[number]); } });
    proc.parentPort = parent;
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, electron] });
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }] });
    const byKey = (key: string) => k.settings.list().find((s) => s.key === key);
    expect(byKey("shortcut_write")).toMatchObject({ section: "system", type: "text", value: "Ctrl+Alt+T" });
    expect((await k.settings.change("shortcut_write", "Ctrl+Alt+F", "ui")).ok).toBe(false);
    expect((await k.settings.change("shortcut_write", "Ctrl+Shift+T", "ui")).ok).toBe(true);
    expect(sent.filter((m) => m.type === "display").at(-1)?.settings?.shortcuts?.write).toBe("Ctrl+Shift+T");
    expect(byKey("shortcut_talk")).toMatchObject({ section: "system", type: "text", value: SHORTCUT_DEFAULTS.talk, group: { fr: "Raccourcis clavier", en: "Keyboard shortcuts" } });
    expect((await k.settings.change("shortcut_talk", "ctrl+shift+p", "ui")).ok).toBe(true);
    expect(byKey("shortcut_talk")?.value).toBe("Ctrl+Shift+P");
    expect(sent.filter((m) => m.type === "display").at(-1)?.settings?.shortcuts?.talk).toBe("Ctrl+Shift+P");
    await k.settings.change("ui_language", "en", "ui");
    const clash = await k.settings.change("shortcut_dictate", "Ctrl+Shift+P", "ui");
    expect(clash).toMatchObject({ ok: false });
    expect(clash.text).toContain("already used");
    expect((await k.settings.change("shortcut_sleep", "", "ui")).ok).toBe(true);
    expect(byKey("shortcut_sleep")?.value).toBe("");
    await k.stopAll();
  });
});
