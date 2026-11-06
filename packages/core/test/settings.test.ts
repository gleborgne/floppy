import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "../src/index.ts";

/** Un plugin avec 3 réglages : libre (voix), accord (cloud), CLI seulement (droits). */
const applied: unknown[] = [];
const p = definePlugin({
  manifest: { id: "p", version: "0", licence: "MIT" },
  apply(ctx) {
    let voix = ctx.settings.saved<string>("voix") ?? "homme";
    let cloud = false;
    let dossier = "aucun";
    ctx.settings.declare([
      { key: "voix", section: "general", label: "Voix", description: "", type: "enum", risk: "free",
        options: [{ value: "homme", label: "voix d'homme", aliases: ["homme"] }, { value: "femme", label: "voix de femme", aliases: ["femme", "féminine"] }],
        get: () => voix, set: (v) => { voix = String(v); applied.push(v); } },
      { key: "cloud", section: "general", label: "Cloud", description: "", type: "boolean", risk: "ask", get: () => cloud, set: (v) => { cloud = Boolean(v); } },
      { key: "dossier", section: "general", label: "Dossier accessible", description: "", type: "enum", risk: "cli",
        options: [{ value: "aucun", label: "aucun" }, { value: "documents", label: "Documents" }], get: () => dossier, set: (v) => { dossier = String(v); } },
    ]);
  },
});

async function boot(home: string) {
  const k = new Kernel({ logger: () => {}, plugins: [p], home });
  await k.applyConfig({ approvals: { timeout_s: 2 }, plugins: [{ id: "p", plugin: "p" }] });
  return k;
}

describe("Réglages à la voix", () => {
  it("libre : appliqué tout de suite par l'outil du cerveau, annulable, gardé au redémarrage", async () => {
    const home = mkdtempSync(join(tmpdir(), "set-"));
    const k = await boot(home);
    const asked: unknown[] = [];
    k.bus.on("approval.request", (r) => asked.push(r));
    const r = await k.tools.call("changer_reglage", { cle: "voix", valeur: "une voix féminine" }, { origin: "avatar" });
    expect(r).toMatchObject({ status: "done", text: "Voix : voix de femme." });
    expect(asked).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toMatchObject({ voix: "femme" });
    expect((await k.tools.call("annuler_reglage", {})).text).toMatch(/revient à voix d'homme/);
    await k.tools.call("changer_reglage", { cle: "voix", valeur: "femme" });
    await k.stopAll();
    const k2 = await boot(home);
    expect(k2.settings.list().find((s) => s.key === "voix")?.value).toBe("femme");
    await k2.stopAll();
  });

  it("accord : demandé avant ; refusé = rien ne change", async () => {
    const k = await boot(mkdtempSync(join(tmpdir(), "set-")));
    k.bus.on("approval.request", (r) => k.approvals.respond(r.id, false, "test"));
    const r = await k.tools.call("changer_reglage", { cle: "cloud", valeur: "oui" });
    expect(r.status).toBe("refused");
    expect(k.settings.list().find((s) => s.key === "cloud")?.value).toBe(false);
    await k.stopAll();
  });

  it("CLI seulement : refusé à la voix, accepté par la CLI", async () => {
    const k = await boot(mkdtempSync(join(tmpdir(), "set-")));
    const r = await k.tools.call("changer_reglage", { cle: "dossier", valeur: "Documents" });
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/ne se change pas à la voix/);
    expect((await k.settings.change("dossier", "documents", "cli")).ok).toBe(true);
    await k.stopAll();
  });

  it("la description de changer_reglage liste les réglages et leurs choix (pour le cerveau)", async () => {
    const k = await boot(mkdtempSync(join(tmpdir(), "set-")));
    const d = k.tools.list().find((t) => t.name === "changer_reglage")!.description;
    expect(d).toMatch(/voix : Voix, actuellement « voix d'homme » \(choix : voix d'homme, voix de femme\)/);
    expect(d).toMatch(/\[pas à la voix\]/);
    await k.stopAll();
    expect(k.tools.list().find((t) => t.name === "changer_reglage")!.description).not.toMatch(/voix d'homme/);
  });
});

describe("Réglages : texte et risque selon la valeur", () => {
  const q = definePlugin({
    manifest: { id: "q", version: "0", licence: "MIT" },
    apply(ctx) {
      let ton = "cordial et chaleureux";
      let cloud = false;
      ctx.settings.declare([
        { key: "ton", section: "general", label: "Ton", description: "", type: "text", group: "Voix et ton", risk: "free", maxLength: 50,
          presets: [{ value: "un peu sarcastique", label: "sarcastique" }], get: () => ton, set: (v) => { ton = String(v); } },
        { key: "connecteur_x", section: "general", label: "Connecteur X", description: "", type: "boolean", group: "Connecteurs", risk: "free",
          riskFor: (v) => (v ? "ask" : "free"), get: () => cloud, set: (v) => { cloud = Boolean(v); } },
      ]);
    },
  });

  it("texte libre, préréglage par son libellé, longueur maximale", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [q], home: mkdtempSync(join(tmpdir(), "set-")) });
    await k.applyConfig({ plugins: [{ id: "q", plugin: "q" }] });
    expect((await k.settings.change("ton", "sarcastique", "voice")).text).toBe("Ton : sarcastique.");
    expect(k.settings.value("ton")).toBe("un peu sarcastique");
    expect((await k.settings.change("ton", "très sarcastique, presque cynique", "voice")).ok).toBe(true);
    expect((await k.settings.change("ton", "x".repeat(60), "voice")).ok).toBe(false);
    expect(k.settings.list().find((s) => s.key === "ton")?.group).toBe("Voix et ton");
    await k.stopAll();
  });

  it("allumer demande l'accord, éteindre non ; la fenêtre (ui) ne demande pas", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [q], home: mkdtempSync(join(tmpdir(), "set-")) });
    await k.applyConfig({ approvals: { timeout_s: 2 }, plugins: [{ id: "q", plugin: "q" }] });
    const asked: string[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r.summary); k.approvals.respond(r.id, true, "test"); });
    expect((await k.settings.change("connecteur_x", "oui", "voice")).ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect((await k.settings.change("connecteur_x", "non", "voice")).ok).toBe(true);
    expect((await k.settings.change("connecteur_x", "oui", "ui")).ok).toBe(true);
    expect(asked).toHaveLength(1);
    await k.stopAll();
  });
});
