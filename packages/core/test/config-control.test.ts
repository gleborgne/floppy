import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, loadConfigFile, watchConfig, startControl, controlCall } from "../src/index.ts";

const quiet = () => {};
const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT", provides: ["x"] }, apply(ctx) { ctx.provide("x", 1); } });

describe("Config", () => {
  it("lit le YAML et applique les valeurs par défaut", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const f = join(dir, "a.yml");
    writeFileSync(f, "plugins:\n  - { id: a, plugin: p }\n");
    const c = loadConfigFile(f);
    expect(c.assistant.name).toBe("Floppy");
    expect(c.approvals.write).toBe("ask");
    expect(c.plugins[0]).toMatchObject({ id: "a", plugin: "p", disabled: false });
  });

  it("refuse un id en double", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const f = join(dir, "a.yml");
    writeFileSync(f, "plugins:\n  - { id: a, plugin: p }\n  - { id: a, plugin: p }\n");
    expect(() => loadConfigFile(f)).toThrow(/id en double/);
  });

  it("recharge à chaud quand le fichier change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const f = join(dir, "a.yml");
    writeFileSync(f, "plugins:\n  - { id: a, plugin: p, disabled: true }\n");
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig(loadConfigFile(f));
    const stop = watchConfig(f, k);
    try {
      writeFileSync(f, "plugins:\n  - { id: a, plugin: p }\n");
      await vi.waitFor(() => expect(k.status()[0]?.state).toBe("active"), { timeout: 5000 });
    } finally {
      stop();
    }
  });
});

describe("Point de contrôle", () => {
  it("répond avec le jeton, refuse sans", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig({ plugins: [{ id: "a", plugin: "p" }] });
    const stop = await startControl(k, home);
    try {
      const r = await controlCall(home, "GET", "/status");
      expect(r.status).toBe(200);
      expect(r.data.plugins[0]).toMatchObject({ id: "a", state: "active" });
      const info = (await import(join(home, "control.json"), { with: { type: "json" } })).default;
      const bad = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { Authorization: "Bearer faux" } });
      expect(bad.status).toBe(401);
    } finally {
      await stop();
    }
  });
});

describe("Point de contrôle : premier lancement fourni par l'hôte", () => {
  it("GET /onboarding passe par le gestionnaire de l'hôte, 501 sans lui", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const k = new Kernel({ logger: quiet, plugins: [p] });
    const sans = await startControl(k, home);
    try {
      expect((await controlCall(home, "GET", "/onboarding")).status).toBe(501);
    } finally {
      await sans();
    }
    const stop = await startControl(k, home, { onboardingPlan: async () => ({ levels: ["a"] }) });
    try {
      const r = await controlCall(home, "GET", "/onboarding");
      expect(r.status).toBe(200);
      expect(r.data).toEqual({ levels: ["a"] });
    } finally {
      await stop();
    }
  });
});
