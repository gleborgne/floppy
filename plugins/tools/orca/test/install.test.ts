import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createOrcaPlugin } from "../src/index.ts";
import { copyState, expectedGrant, installOrcaPlugin, ORCA_PLUGIN_SRC, syncFolder, type OrcaReply } from "../src/install.ts";

// Bouton « Installer dans Orca » : copie le plugin Orca dans le dossier de Floppy, puis le charge dans Orca.
const FP = "ap1-166647625af0f9038cc2cc36c72725b8";
const grant = (over: Record<string, unknown> = {}) => ({
  pluginKey: "local.floppy", approvalFingerprint: FP,
  grants: { execution: "trusted-worker", capabilities: [{ kind: "agent:read" }], contributions: [{ kind: "events", name: "agent.status.changed" }] },
  ...over,
});
const needApproval = (data: unknown): OrcaReply => ({ code: 3, json: { ok: false, error: { code: "approval_required", message: "needs approval", data } } });
const okReply: OrcaReply = { code: 0, json: { ok: true, result: {} } };

/** Faux Orca : note les commandes, demande l'accord au premier chargement. */
function fakeOrca(opts: { up?: boolean; data?: unknown } = {}) {
  const calls: string[][] = [];
  const cli = async (args: string[]): Promise<OrcaReply> => {
    calls.push(args);
    if (opts.up === false) return { code: -1 };
    if (args[1] === "dev" && args[2] === "load" && !args.includes("--approve")) return needApproval(opts.data ?? grant());
    return okReply;
  };
  return { cli, calls };
}

const home = () => mkdtempSync(join(tmpdir(), "orca-install-"));

describe("installation du plugin Orca", () => {
  it("copie le plugin, retire l'ancien dossier de dev, charge, puis donne l'accord prévu", async () => {
    const h = home();
    const o = fakeOrca();
    const r = await installOrcaPlugin(h, o.cli);
    expect(r.ok).toBe(true);
    const dir = join(h, "orca-plugin");
    expect(existsSync(join(dir, "orca-plugin.json"))).toBe(true);
    expect(o.calls).toEqual([
      ["plugin", "list"],
      ["plugin", "dev", "unload", "local.floppy"],
      ["plugin", "dev", "load", dir],
      ["plugin", "dev", "load", dir, "--approve", FP],
    ]);
    expect(copyState(h)).toBe("a_jour");
  });

  it("Orca fermé : le dit, ne copie rien", async () => {
    const h = home();
    const r = await installOrcaPlugin(h, fakeOrca({ up: false }).cli);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.text)).toContain("Ouvre Orca");
    expect(copyState(h)).toBe("absent");
  });

  it("accès différent de celui prévu : n'autorise rien", async () => {
    const h = home();
    const extra = grant({ grants: { execution: "trusted-worker", capabilities: [{ kind: "agent:read" }, { kind: "terminal:write" }], contributions: [] } });
    const o = fakeOrca({ data: extra });
    const r = await installOrcaPlugin(h, o.cli);
    expect(r.ok).toBe(false);
    expect(o.calls.some((c) => c.includes("--approve"))).toBe(false);
  });

  it("accord attendu : seulement le plugin Floppy, un worker, la lecture de l'état des agents", () => {
    expect(expectedGrant(grant())).toBe(FP);
    expect(expectedGrant(grant({ pluginKey: "local.autre" }))).toBeUndefined();
    expect(expectedGrant(grant({ approvalFingerprint: "ap1-x; rm -rf" }))).toBeUndefined();
    expect(expectedGrant(grant({ grants: { execution: "trusted-worker", capabilities: [{ kind: "agent:read" }], contributions: [{ kind: "commands", name: "x" }] } }))).toBeUndefined();
    expect(expectedGrant(undefined)).toBeUndefined();
  });

  it("copie plus ancienne que le plugin livré : à mettre à jour", async () => {
    const src = mkdtempSync(join(tmpdir(), "orca-src-"));
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "orca-plugin.json"), "{}");
    writeFileSync(join(src, "src", "worker.ts"), "v1");
    const h = home();
    expect(copyState(h, src)).toBe("absent");
    await installOrcaPlugin(h, fakeOrca().cli, src);
    expect(copyState(h, src)).toBe("a_jour");
    // Les typages qu'Orca écrit dans .orca ne comptent pas.
    mkdirSync(join(h, "orca-plugin", ".orca"));
    writeFileSync(join(h, "orca-plugin", ".orca", "types.d.ts"), "x");
    expect(copyState(h, src)).toBe("a_jour");
    writeFileSync(join(src, "src", "worker.ts"), "v2");
    expect(copyState(h, src)).toBe("ancien");
    await installOrcaPlugin(h, fakeOrca().cli, src);
    expect(readFileSync(join(h, "orca-plugin", "src", "worker.ts"), "utf8")).toBe("v2");
  });

  it("mise à jour sur place : fichiers remplacés, anciens retirés, .orca gardé, dossier jamais supprimé", () => {
    const src = mkdtempSync(join(tmpdir(), "orca-src-"));
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "orca-plugin.json"), "{}");
    writeFileSync(join(src, "src", "worker.ts"), "v2");
    const dir = mkdtempSync(join(tmpdir(), "orca-dst-"));
    mkdirSync(join(dir, "src")); mkdirSync(join(dir, ".orca"));
    writeFileSync(join(dir, "src", "worker.ts"), "v1");
    writeFileSync(join(dir, "src", "ancien.ts"), "x");
    writeFileSync(join(dir, ".orca", "types.d.ts"), "t");
    syncFolder(src, dir);
    expect(readFileSync(join(dir, "src", "worker.ts"), "utf8")).toBe("v2");
    expect(existsSync(join(dir, "src", "ancien.ts"))).toBe(false);
    expect(existsSync(join(dir, ".orca", "types.d.ts"))).toBe(true);
    expect(existsSync(join(dir, "orca-plugin.json"))).toBe(true);
  });

  it("le plugin livré est bien là", () => {
    expect(existsSync(join(ORCA_PLUGIN_SRC, "orca-plugin.json"))).toBe(true);
  });
});

describe("bouton dans les réglages", () => {
  let k: Kernel | undefined;
  afterEach(async () => { await k?.stopAll(); k = undefined; });

  it("« Installer dans Orca », puis « Réinstaller » ; clic seulement", async () => {
    const h = home();
    const o = fakeOrca();
    k = new Kernel({ logger: () => {}, home: h, plugins: [createOrcaPlugin({ run: async () => [], cli: async () => ({}), pluginCli: o.cli, bridge: false, phrase: async () => undefined })] });
    await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: {} }] });
    const entry = async () => (await k!.items.provider("apps-connecteurs")!.list()).find((i) => i.kind === "orca")!;
    expect(JSON.stringify((await entry()).actions)).toContain("Installer dans Orca");
    expect(JSON.stringify((await entry()).statusText)).toContain("installe le plugin Orca");
    expect((await k.items.run({ op: "action", provider: "apps-connecteurs", id: "orca", action: "orca-plugin" }, "voice")).ok).toBe(false);
    expect(o.calls).toHaveLength(0);
    const r = await k.items.run({ op: "action", provider: "apps-connecteurs", id: "orca", action: "orca-plugin" }, "ui");
    expect(r.ok).toBe(true);
    expect(JSON.stringify((await entry()).actions)).toContain("Réinstaller dans Orca");
    expect(JSON.stringify((await entry()).statusText)).not.toContain("installe le plugin");
  });
});
