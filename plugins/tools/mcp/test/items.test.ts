// Tests du fournisseur d'éléments « connectors » : ajout à chaud, extinction, choix des outils, commande, secrets.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, MemoryAudit, MemorySecrets, SECRET_SET, type ItemInfo } from "@floppy/core";
import tools from "../src/index.ts";
import { brandLogo } from "../src/connectors.ts";
import { serverIcon, type Spec } from "../src/connection.ts";
import { AZURE_DEVOPS, OBSIDIAN } from "../src/logos.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures", "fake-mcp.mjs");
const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function start(servers: Record<string, unknown> = {}, home = mkdtempSync(join(tmpdir(), "items-"))) {
  const secrets = new MemorySecrets();
  const k = new Kernel({ logger: () => {}, audit: new MemoryAudit(), plugins: [tools], home, secrets });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "tools", plugin: "tools", config: { port: 0, servers } }] });
  const run = (op: Record<string, unknown>, via: "ui" | "cli" | "voice" = "ui") =>
    k.items.run({ provider: "connectors", ...op } as never, via);
  const list = async (): Promise<ItemInfo[]> => k.items.provider("connectors")!.list();
  const item = async (id: string) => (await list()).find((i) => i.id === id)!;
  const names = () => k.tools.list().filter((t) => t.source !== "core").map((t) => t.name).sort();
  const file = () => readFileSync(join(home, "items", "tools.json"), "utf8");
  return { k, home, secrets, run, list, item, names, file };
}

const localForm = (extra: Record<string, unknown> = {}) => ({ label: "Notes", command: process.execPath, args: [fake], ...extra });

describe("connecteurs : éléments", () => {
  it("ajoute un MCP local à chaud, sans toucher aux autres", async () => {
    const s = await start({ base: { command: process.execPath, args: [fake], include: ["planter"] } });
    expect(s.names()).toEqual(["planter"]);
    const r = await s.run({ op: "add", kind: "mcp-local", values: localForm({ toolFilter: ["*_note"] }) });
    expect(r).toMatchObject({ ok: true, id: "notes" });
    expect(r.children!.map((c) => c.id)).toContain("lire_note");
    expect(s.names()).toEqual(["ecrire_note", "lire_note", "planter", "supprimer_note"]);
    const it = await s.item("notes");
    expect(it).toMatchObject({ enabled: true, status: "ok", kind: "mcp-local", editable: true, removable: true });
    expect(it.statusText).toEqual({ fr: "connecté · 3 outils sur 5", en: "connected · 3 tools of 5" });
    expect(JSON.parse(s.file()).added.notes.kind).toBe("mcp-local");
  });

  it("la désactivation à chaud retire les outils de ce connecteur seul, et reste en liste", async () => {
    const s = await start({
      a: { command: process.execPath, args: [fake], include: ["planter"] },
      b: { command: process.execPath, args: [fake], include: ["lire_note"] },
    });
    expect(s.names()).toEqual(["lire_note", "planter"]);
    expect((await s.run({ op: "enable", id: "a", on: false })).ok).toBe(true);
    expect(s.names()).toEqual(["lire_note"]);
    expect(await s.item("a")).toMatchObject({ enabled: false, status: "off" });
    // Gardé après un redémarrage.
    const s2 = await start({ a: { command: process.execPath, args: [fake], include: ["planter"] }, b: { command: process.execPath, args: [fake], include: ["lire_note"] } }, s.home);
    expect(s2.names()).toEqual(["lire_note"]);
    expect((await s2.run({ op: "enable", id: "a", on: true })).ok).toBe(true);
    expect(s2.names()).toEqual(["lire_note", "planter"]);
  });

  it("setChild choisit les outils donnés au cerveau", async () => {
    const s = await start({ srv: { command: process.execPath, args: [fake], include: ["*_note"] } });
    expect(s.names()).toEqual(["ecrire_note", "lire_note", "supprimer_note"]);
    await s.run({ op: "child", id: "srv", child: "supprimer_note", on: false });
    await s.run({ op: "child", id: "srv", child: "planter", on: true });
    expect(s.names()).toEqual(["ecrire_note", "lire_note", "planter"]);
    const it = await s.item("srv");
    expect(it.children!.find((c) => c.id === "supprimer_note")).toMatchObject({ enabled: false, tag: { fr: "suppression · accord" } });
    expect(it.children!.find((c) => c.id === "planter")!.enabled).toBe(true);
  });

  it("test() liste les outils sans rien enregistrer", async () => {
    const s = await start();
    const r = await s.k.items.run({ op: "test", provider: "connectors", kind: "mcp-local", values: localForm() }, "ui");
    expect(r.ok).toBe(true);
    expect(r.children).toHaveLength(5);
    expect(s.names()).toEqual([]);
    expect(await s.list()).toEqual([]);
    const bad = await s.k.items.run({ op: "test", provider: "connectors", kind: "mcp-local", values: { label: "x", command: "commande-qui-n-existe-pas-xyz" } }, "ui");
    expect(bad.ok).toBe(false);
  });

  it("modifier et supprimer ; pas à la voix", async () => {
    const s = await start();
    await s.run({ op: "add", kind: "mcp-local", values: localForm() });
    expect((await s.run({ op: "update", id: "notes", values: localForm({ label: "Notes bis", toolFilter: ["lire_note"] }) })).ok).toBe(true);
    expect(s.names()).toEqual(["lire_note"]);
    expect((await s.item("notes")).label).toBe("Notes bis");
    expect((await s.run({ op: "remove", id: "notes" }, "voice")).ok).toBe(false);
    expect((await s.run({ op: "remove", id: "notes" })).ok).toBe(true);
    expect(s.names()).toEqual([]);
    expect(await s.list()).toEqual([]);
  });

  it("migre une seule fois les anciens réglages connecteur_<clé>", async () => {
    const home = mkdtempSync(join(tmpdir(), "items-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ connecteur_a: false }));
    const cfg = { a: { command: process.execPath, args: [fake], include: ["planter"] } };
    const s = await start(cfg, home);
    expect(s.names()).toEqual([]);
    expect((await s.item("a")).enabled).toBe(false);
    expect(JSON.parse(s.file()).extra.migrated).toBe(true);
    // L'ancien réglage ne compte plus : l'ItemStore décide.
    await s.run({ op: "enable", id: "a", on: true });
    writeFileSync(join(home, "settings.json"), JSON.stringify({ connecteur_a: false }));
    const s2 = await start(cfg, home);
    expect(s2.names()).toEqual(["planter"]);
  });
});

describe("connecteur de type commande", () => {
  const cmd = (extra: Record<string, unknown> = {}) => ({
    label: "Écho texte", description: "Répète le texte.", command: process.execPath,
    args: ["-e", "console.log('>' + process.argv[1])", "{texte}"], level: "read", ...extra,
  });

  it("devient un outil : {texte} remplacé, sans shell", async () => {
    const s = await start();
    expect((await s.run({ op: "add", kind: "command", values: cmd() })).ok).toBe(true);
    expect(s.names()).toEqual(["echo_texte"]);
    const info = s.k.tools.list().find((t) => t.name === "echo_texte")!;
    expect(info.level).toBe("read");
    const r = await s.k.tools.call("echo_texte", { texte: "salut & echo piraté" });
    expect(r).toMatchObject({ status: "done", text: ">salut & echo piraté" });
    expect(await s.item("echo-texte")).toMatchObject({ enabled: true, status: "ok", kind: "command" });
  });

  it("niveau écriture, sortie tronquée, délai", async () => {
    const s = await start();
    await s.run({ op: "add", kind: "command", values: cmd({ label: "gros", level: "write", args: ["-e", "0"] }) });
    expect(s.k.tools.list().find((t) => t.name === "gros")!.level).toBe("write");
    await s.run({ op: "add", kind: "command", values: cmd({ label: "lent", args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutS: 1 }) });
    const t0 = Date.now();
    const slow = await s.k.tools.call("lent", {});
    expect(slow.status).toBe("failed");
    expect(slow.text).toMatch(/Délai dépassé/);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("sortie tronquée (lecture)", async () => {
    const s = await start();
    await s.run({ op: "add", kind: "command", values: cmd({ label: "gros", args: ["-e", "process.stdout.write('x'.repeat(9000))"] }) });
    const r = await s.k.tools.call("gros", {});
    expect(r.status).toBe("done");
    expect(r.text.length).toBeLessThan(4100);
    expect(r.text).toMatch(/tronquée/);
  });
});

describe("secrets", () => {
  it("jamais dans le fichier ni dans les valeurs renvoyées ; rangés dans ctx.secrets", async () => {
    const s = await start();
    await s.run({ op: "add", kind: "mcp-local", values: localForm({ secretEnvName: "API_KEY", secretEnvValue: "super-secret-1" }) });
    expect(s.secrets.get("tools/notes/env")).toBe("super-secret-1");
    expect(s.file()).not.toContain("super-secret-1");
    const it = await s.item("notes");
    expect(it.values!.secretEnvValue).toBe(SECRET_SET);
    expect(JSON.stringify(it)).not.toContain("super-secret-1");
    // SECRET_SET = inchangé.
    await s.run({ op: "update", id: "notes", values: { ...it.values, secretEnvValue: SECRET_SET } });
    expect(s.secrets.get("tools/notes/env")).toBe("super-secret-1");
    // Jeton d'un MCP distant.
    await s.run({ op: "add", kind: "mcp-remote", values: { label: "Distant", url: "http://127.0.0.1:1/mcp", connection: "token", token: "jeton-xyz" } });
    expect(s.secrets.get("tools/distant/token")).toBe("jeton-xyz");
    expect(s.file()).not.toContain("jeton-xyz");
    expect((await s.item("distant")).values!.token).toBe(SECRET_SET);
    // Supprimer efface les secrets.
    await s.run({ op: "remove", id: "notes" });
    expect(s.secrets.has("tools/notes/env")).toBe(false);
  });
});

describe("connecteurs : langue anglaise", () => {
  it("messages de la fenêtre et erreurs de formulaire en anglais si l'interface est en anglais", async () => {
    const s = await start();
    await s.k.settings.change("langue_interface", "en", "ui");
    expect((await s.run({ op: "enable", id: "nope", on: true })).text).toBe("Unknown connector.");
    expect((await s.run({ op: "add", kind: "mcp-local", values: localForm({ levels: { ask: "bad" } }) })).text)
      .toBe("Unknown level for “ask”: “bad”. Choose read, write, send, delete, physical or never.");
    const r = await s.run({ op: "add", kind: "mcp-local", values: localForm() });
    expect(r.text).toBe("“Notes” is added and turned on.");
    // En français, rien ne change.
    await s.k.settings.change("langue_interface", "fr", "ui");
    expect((await s.run({ op: "enable", id: "nope", on: true })).text).toBe("Connecteur inconnu.");
  });
});

describe("connecteurs : logos", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("montre l'icône envoyée par le serveur (data: seulement, jamais une adresse web)", async () => {
    const s = await start({ notes: { command: process.execPath, args: [fake], env: { FAKE_ICON: PNG } } });
    expect((await s.item("notes")).logo).toBe(PNG);
  });

  it("sans icône du serveur : le logo d'une marque connue, sinon rien", async () => {
    const s = await start({
      vault: { command: process.execPath, args: [fake, "~/Notes/obsidian"] },
      autre: { command: process.execPath, args: [fake] },
    });
    expect(String((await s.item("vault")).logo)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect((await s.item("autre")).logo).toBeUndefined();
  });
});

describe("brandLogo / serverIcon", () => {
  it("reconnaît Azure DevOps par l'adresse ou la commande, Obsidian par la commande", () => {
    const spec = (x: Partial<Spec>): Spec => ({ kind: "mcp-local", args: [], env: {}, headers: {}, cloud: false, levels: {}, exclude: [], ...x });
    expect(brandLogo(spec({ kind: "mcp-remote", url: "https://mcp.dev.azure.com/contoso" }))).toBe(AZURE_DEVOPS);
    expect(brandLogo(spec({ command: "npx", args: ["-y", "@azure-devops/mcp", "contoso"] }))).toBe(AZURE_DEVOPS);
    expect(brandLogo(spec({ command: "node", args: ["services/obsidian-mcp/server.mjs", "~/Notes"] }))).toBe(OBSIDIAN);
    expect(brandLogo(spec({ kind: "mcp-remote", url: "https://contoso.com/mcp" }))).toBeUndefined();
    expect(brandLogo(spec({ kind: "command", command: "obsidian" }))).toBeUndefined();
  });

  it("serverIcon : SVG d'abord, sinon la plus grande ; ignore les adresses web", () => {
    const png = (n: string) => `data:image/png;base64,${n}`;
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(serverIcon([{ src: png("A"), sizes: ["16x16"] }, { src: png("B"), sizes: ["64x64"] }])).toBe(png("B"));
    expect(serverIcon([{ src: png("A"), sizes: ["64x64"] }, { src: svg }])).toBe(svg);
    expect(serverIcon([{ src: "https://contoso.com/a.svg" }])).toBeUndefined();
    expect(serverIcon(undefined)).toBeUndefined();
  });
});
