// « Ouvre les réglages d'Orca » : la fenêtre s'ouvre sur la page de l'élément, et Floppy dit sur quel bouton cliquer.
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Kernel, definePlugin, T, type ProviderSnapshot } from "@floppy/core";
import bodyHub from "@floppy/plugin-body-hub";
import bodyElectron from "../src/index.ts";
import { findSettingsTarget } from "../src/settings-target.ts";

// Faux canal de l'app de bureau, donné au noyau (option host) : plus aucun objet global du processus.
const proc: { parentPort?: unknown } = {};

const snap = (section: string, id: string, items: { id: string; label: ProviderSnapshot["items"][number]["label"]; actions?: { id: string; label: string }[] }[], layout: ProviderSnapshot["layout"] = "list") =>
  ({ id, section, layout, items } as unknown as ProviderSnapshot);

describe("trouver l'élément des réglages", () => {
  const providers = [
    snap("connectors", "apps-connectors", [
      { id: "orca", label: "Orca", actions: [{ id: "orca-plugin", label: "Installer dans Orca" }] },
      { id: "m365", label: { fr: "Microsoft 365", en: "Microsoft 365" } },
    ]),
    snap("voice", "voices", [{ id: "siwis", label: { fr: "Voix Siwis", en: "Siwis voice" } }]),
    snap("modeles", "lib", [{ id: "orca-mini", label: "Orca" }], "library"),
  ];

  it("nom exact, nom dans le libellé, dictée approximative, autre langue", () => {
    expect(findSettingsTarget(providers, "Orca")?.target).toEqual({ section: "connectors", provider: "apps-connectors", id: "orca" });
    expect(findSettingsTarget(providers, "orka")?.target.id).toBe("orca");
    expect(findSettingsTarget(providers, "microsoft")?.target.id).toBe("m365");
    expect(findSettingsTarget(providers, "Siwis voice")?.target.id).toBe("siwis");
    expect(findSettingsTarget(providers, "Orca")?.actions).toEqual(["Installer dans Orca"]);
  });

  it("rien de proche : rien ; les bibliothèques de modèles sont ignorées", () => {
    expect(findSettingsTarget(providers, "Telegram")).toBeUndefined();
    expect(findSettingsTarget([providers[2]!], "Orca")).toBeUndefined();
  });
});

describe("ouvrir_reglages sur un élément", () => {
  afterEach(() => { delete proc.parentPort; });

  it("envoie la page à la fenêtre et dit les boutons ; élément introuvable : réglages ouverts quand même", async () => {
    const parent = new EventEmitter() as EventEmitter & { postMessage(m: unknown): void };
    const requests: { type: string; reqId: string; target?: unknown }[] = [];
    parent.postMessage = (m) => {
      const r = m as (typeof requests)[number];
      if (r?.type !== "settings.open") return;
      requests.push(r);
      setTimeout(() => parent.emit("message", { data: { type: "settings.open.result", reqId: r.reqId, ok: true } }), 0);
    };
    proc.parentPort = parent;
    const fake = definePlugin({
      manifest: { id: "faux-orca", version: "0.0.0", description: "test", licence: "MIT" },
      apply(ctx) {
        ctx.items.declare({
          id: "apps-test", section: "connectors", label: "Apps",
          list: () => [{ id: "orca", label: "Orca", enabled: true, actions: [{ id: "orca-plugin", label: T("Installer dans Orca", "Install in Orca") }] }],
          action: async () => ({ ok: true, text: "ok" }),
        });
      },
    });
    const k = new Kernel({ host: proc.parentPort as never, logger: () => {}, plugins: [bodyHub, bodyElectron, fake] });
    await k.applyConfig({ plugins: [{ id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron" }, { id: "faux", plugin: "faux-orca" }] });
    try {
      const r = await k.tools.call("ouvrir_reglages", { element: "orka" });
      expect(requests.at(-1)?.target).toEqual({ section: "connectors", provider: "apps-test", id: "orca" });
      expect(r).toMatchObject({ status: "done" });
      expect(JSON.stringify(r)).toContain("« Installer dans Orca »");
      const none = await k.tools.call("ouvrir_reglages", { element: "Telegram" });
      expect(requests.at(-1)?.target).toBeUndefined();
      expect(JSON.stringify(none)).toContain("Telegram");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
    } finally { await k.stopAll(); }
  });
});
