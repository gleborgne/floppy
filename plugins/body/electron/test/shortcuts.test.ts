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

const proc = process as unknown as { parentPort?: unknown };

describe("réglages des raccourcis", () => {
  afterEach(() => { delete proc.parentPort; });

  it("un réglage par action dans Système, valeur par défaut, conflit refusé, vide = désactivé", async () => {
    // Le plugin parle au processus principal d'Electron : on le remplace par un faux, qui garde les messages « display ».
    const sent: { type: string; settings?: { raccourcis?: Record<string, string> } }[] = [];
    const parent = Object.assign(new EventEmitter(), { postMessage: (m: unknown) => { sent.push(m as (typeof sent)[number]); } });
    proc.parentPort = parent;
    const k = new Kernel({ logger: () => {}, plugins: [bodyHub, electron] });
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }] });
    const byKey = (key: string) => k.settings.list().find((s) => s.key === key);
    expect(byKey("raccourci_parler")).toMatchObject({ section: "systeme", type: "text", value: SHORTCUT_DEFAULTS.parler, group: { fr: "Raccourcis clavier", en: "Keyboard shortcuts" } });
    expect((await k.settings.change("raccourci_parler", "ctrl+shift+p", "ui")).ok).toBe(true);
    expect(byKey("raccourci_parler")?.value).toBe("Ctrl+Shift+P");
    expect(sent.filter((m) => m.type === "display").at(-1)?.settings?.raccourcis?.parler).toBe("Ctrl+Shift+P");
    await k.settings.change("langue_interface", "en", "ui");
    const clash = await k.settings.change("raccourci_dicter", "Ctrl+Shift+P", "ui");
    expect(clash).toMatchObject({ ok: false });
    expect(clash.text).toContain("already used");
    expect((await k.settings.change("raccourci_dormir", "", "ui")).ok).toBe(true);
    expect(byKey("raccourci_dormir")?.value).toBe("");
    await k.stopAll();
  });
});
