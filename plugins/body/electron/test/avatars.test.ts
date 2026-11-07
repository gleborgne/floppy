// Avatars = plugins de la famille plugins/avatar/<id>/ : chacun s'inscrit auprès du service `avatars` de body-electron,
// qui les liste dans les réglages, garde le choix et envoie au corps l'adresse du dessin choisi.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Kernel, type PluginDef } from "@floppy/core";
import bodyHub from "@floppy/plugin-body-hub";
import avatarTv from "@floppy/plugin-avatar-tv";
import avatarPixel from "@floppy/plugin-avatar-pixel";
import bodyElectron, { defineAvatar, readAvatarDir } from "../src/index.ts";

// Faux canal de l'app de bureau, donné au noyau (option host) : plus aucun objet global du processus.
const proc: { parentPort?: unknown } = {};

describe("avatars (plugins)", () => {
  const oldHome = process.env.FLOPPY_HOME;
  let k: Kernel | undefined;
  afterEach(async () => {
    await k?.stopAll();
    delete proc.parentPort;
    if (oldHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = oldHome;
  });

  const boot = async (home: string, extra: PluginDef<any>[] = [], avatar = "tv") => {
    process.env.FLOPPY_HOME = home;
    const sent: { type: string; settings?: Record<string, unknown> }[] = [];
    proc.parentPort = { on: () => {}, postMessage: (m: never) => { sent.push(m); } };
    k = new Kernel({ host: proc.parentPort as never, logger: () => {}, home, plugins: [bodyHub, bodyElectron, avatarTv, avatarPixel, ...extra] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] }, approvals: { timeout_s: 5 },
      plugins: [
        { id: "body", plugin: "body-hub" }, { id: "bodyel", plugin: "body-electron", config: avatar ? { avatar } : {} },
        { id: "avatar-tv", plugin: "avatar-tv" }, { id: "avatar-pixel", plugin: "avatar-pixel" },
        ...extra.map((p) => ({ id: p.manifest.id, plugin: p.manifest.id })),
      ],
    });
    return sent;
  };
  const list = async () => (await k!.items.snapshot()).find((p) => p.id === "avatars")!;
  const lastDisplay = (sent: { type: string; settings?: Record<string, unknown> }[]) => [...sent].reverse().find((m) => m.type === "display")?.settings;

  it("tv et pixel sont des plugins (plugins/avatar/) ; tv est utilisé au départ, avec l'adresse de son dessin", async () => {
    expect(avatarTv.manifest.id).toBe("avatar-tv");
    const sent = await boot(mkdtempSync(join(tmpdir(), "av-")));
    const p = await list();
    expect(p.items.map((i) => i.id).sort()).toEqual(["pixel", "tv"]);
    expect(p.items.find((i) => i.id === "tv")).toMatchObject({ enabled: true, active: true, toggleable: false });
    expect(p.items.find((i) => i.id === "pixel")!.actions).toEqual([{ id: "use", label: { fr: "Utiliser", en: "Use" }, voice: true }]);
    const d = lastDisplay(sent)!;
    expect(d.avatar).toBe("tv");
    expect(String(d.avatarUrl)).toMatch(/^file:.*plugins\/avatar\/tv\/renderer\/index\.js$/);
  });

  it("sans choix ni config : le premier avatar par id (aucun n'est codé en dur)", async () => {
    const sent = await boot(mkdtempSync(join(tmpdir(), "av-")), [], "");
    expect(lastDisplay(sent)!.avatar).toBe("pixel");
  });

  it("Utiliser envoie l'avatar au corps et le choix est gardé au redémarrage", async () => {
    const home = mkdtempSync(join(tmpdir(), "av-"));
    const sent = await boot(home);
    expect((await k!.items.run({ op: "action", provider: "avatars", id: "pixel", action: "use" }, "ui")).ok).toBe(true);
    expect(lastDisplay(sent)).toMatchObject({ avatar: "pixel" });
    expect(String(lastDisplay(sent)!.avatarUrl)).toMatch(/avatar\/pixel\/renderer\/index\.js$/);
    await k!.stopAll();
    const sent2 = await boot(home);
    expect(lastDisplay(sent2)!.avatar).toBe("pixel");
  });

  it("on ne désactive pas l'avatar affiché ; un avatar désactivé reste dans la liste", async () => {
    await boot(mkdtempSync(join(tmpdir(), "av-")));
    expect((await k!.items.run({ op: "enable", provider: "avatars", id: "tv", on: false }, "ui")).ok).toBe(false);
    expect((await k!.items.run({ op: "enable", provider: "avatars", id: "pixel", on: false }, "ui")).ok).toBe(true);
    expect((await list()).items.find((i) => i.id === "pixel")!.enabled).toBe(false);
  });

  it("un nouvel avatar = un plugin de plus (defineAvatar) ; un avatar.json invalide est refusé", async () => {
    const root = mkdtempSync(join(tmpdir(), "avplug-"));
    mkdirSync(join(root, "renderer"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "avatar.json"), JSON.stringify({ id: "bob", name: { fr: "Bob", en: "Bob" }, description: "d", emotions: ["neutral", "joy"] }));
    writeFileSync(join(root, "renderer", "index.js"), "export function create() {}");
    const bob = defineAvatar(pathToFileURL(join(root, "src", "index.ts")).href);
    expect(bob.manifest.id).toBe("avatar-bob");
    await boot(mkdtempSync(join(tmpdir(), "av-")), [bob]);
    expect((await list()).items.find((i) => i.id === "bob")!.tags).toEqual([{ fr: "2 émotions", en: "2 emotions" }]);

    const bad = mkdtempSync(join(tmpdir(), "avbad-"));
    writeFileSync(join(bad, "avatar.json"), JSON.stringify({ id: "../x" }));
    expect(() => readAvatarDir(bad)).toThrow(/id invalide/);
  });
});
