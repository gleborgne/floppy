// Tests de sécurité des connecteurs : commande (niveau, injection d'option), formulaire, délais de connexion.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Kernel, MemoryAudit, MemorySecrets } from "@floppy/core";
import type { McpEndpoint } from "@floppy/contracts";
import tools from "../src/index.ts";
import { formToPatch, toSpec, TEST_LIMIT } from "../src/connectors.ts";
import { open, type Spec } from "../src/connection.ts";

const here = dirname(fileURLToPath(import.meta.url));
const slow = join(here, "fixtures", "slow-mcp.mjs");
const fake = join(here, "fixtures", "fake-mcp.mjs");
const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); TEST_LIMIT.ms = 30_000; });

async function start(servers: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "sec-"));
  const k = new Kernel({ logger: () => {}, audit: new MemoryAudit(), plugins: [tools], home, secrets: new MemorySecrets() });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "tools", plugin: "tools", config: { port: 0, servers } }] });
  await k.service<McpEndpoint>("mcp")?.connected?.();
  const run = (op: Record<string, unknown>) => k.items.run({ provider: "connectors", ...op } as never, "ui");
  const item = async (id: string) => (await k.items.provider("connectors")!.list()).find((i) => i.id === id)!;
  return { k, run, item };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidOf = (f: string): number => Number(readFileSync(f, "utf8"));
/**
 * Attend (au plus `ms`) que le processus du fichier de pid ait disparu : le test regarde la condition réelle, pas un instant
 * fixe, car la mort d'un processus et le moment où il écrit son pid dépendent de la charge de la machine. Le premier
 * coup d'œil est immédiat (pas d'attente inutile, et un pid libéré n'a pas le temps d'être réattribué à un autre processus).
 */
async function waitGone(pidFile: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (existsSync(pidFile) && !alive(pidOf(pidFile))) return true;
    if (Date.now() >= end) return false;
    await wait(50);
  }
}

describe("commande : niveau et injection d'option", () => {
  const cmd = (extra: Record<string, unknown> = {}) => ({
    label: "Écho", description: "Répète.", command: process.execPath, args: ["-e", "console.log('>' + process.argv[1])", "{texte}"], ...extra,
  });

  it("niveau par défaut = écriture ; lecture seulement si choisie", async () => {
    expect(formToPatch("command", cmd()).level).toBe("write");
    expect(formToPatch("command", cmd({ level: "read" })).level).toBe("read");
    const s = await start();
    await s.run({ op: "add", kind: "command", values: cmd() });
    expect(s.k.tools.list().find((t) => t.name === "echo")!.level).toBe("write");
    // Un spec sans niveau (ancienne config) passe aussi par l'accord.
    const o = await open("c", toSpec({ kind: "command", command: process.execPath, label: "x" }), undefined);
    expect(o.tools[0]!.level).toBe("write");
  });

  it("un texte qui commence par « - » est refusé (injection d'option)", async () => {
    const s = await start();
    await s.run({ op: "add", kind: "command", values: cmd({ level: "read" }) });
    for (const texte of ["--output=x", "-rf", "  -x"]) {
      const r = await s.k.tools.call("echo", { texte });
      expect(r.status).toBe("failed");
      expect(r.text).toContain("commencer par « - »");
    }
    expect(await s.k.tools.call("echo", { texte: "a-b" })).toMatchObject({ status: "done", text: ">a-b" });
  });
});

describe("formulaire : levels, note, include", () => {
  const local = (extra: Record<string, unknown> = {}) => ({ label: "L", command: "x", ...extra });

  it("levels (clé/valeur) et note passent dans le patch ; valeur inconnue refusée", () => {
    const p = formToPatch("mcp-local", local({ levels: [["ask", "read"], ["del_*", "never"]], note: " ma note " }));
    expect(p.levels).toEqual({ ask: "read", "del_*": "never" });
    expect(p.note).toBe("ma note");
    expect(() => formToPatch("mcp-local", local({ levels: { ask: "lecture" } }))).toThrow(/Niveau inconnu/);
    expect(formToPatch("mcp-remote", { label: "R", url: "https://x.test/mcp", levels: { a: "send" } }).levels).toEqual({ a: "send" });
  });

  it("include absent du patch quand le filtre est vide", () => {
    expect("include" in formToPatch("mcp-local", local())).toBe(false);
    expect("include" in formToPatch("mcp-remote", { label: "R", url: "https://x.test/mcp" })).toBe(false);
    expect(formToPatch("mcp-local", local({ toolFilter: ["a*"] })).include).toEqual(["a*"]);
  });

  it("modifier un serveur de la config sans filtre garde son include ; levels et note reviennent dans le formulaire", async () => {
    const s = await start({ base: { command: process.execPath, args: [fake], include: ["planter"], levels: { planter: "read" }, note: "N" } });
    const f = (await s.item("base")).values as Record<string, unknown>;
    expect(f).toMatchObject({ toolFilter: ["planter"], levels: { planter: "read" }, note: "N" });
    const { toolFilter: _t, ...rest } = f;
    const r = await s.run({ op: "update", id: "base", values: { ...rest, label: "Base2" } });
    expect(r.ok).toBe(true);
    const after = await s.item("base");
    expect(after.children!.filter((c) => c.enabled).map((c) => c.id)).toEqual(["planter"]);
  });
});

describe("délais de connexion", () => {
  const spec = (env: Record<string, string>): Spec => ({ kind: "mcp-local", command: process.execPath, args: [slow], env, cloud: false, headers: {}, levels: {}, exclude: [] });

  it("open() : serveur muet = erreur au bout du délai, processus fermé", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "pid-")), "pid");
    const t0 = Date.now();
    await expect(open("muet", spec({ PID_FILE: pidFile }), undefined, { timeoutMs: 800 })).rejects.toThrow(/pas de réponse/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // open() attend la fermeture avant de rejeter : le processus est déjà parti (marge bornée pour l'OS chargé).
    expect(await waitGone(pidFile, 5000)).toBe(true);
  }, 20_000);

  it("test() : un open() tardif est refermé (pas de processus laissé)", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "pid-")), "pid");
    TEST_LIMIT.ms = 500;
    const s = await start();
    const r = await s.run({ op: "test", kind: "mcp-local", values: { label: "T", command: process.execPath, args: [slow], env: { PID_FILE: pidFile, DELAY_MS: "1500" } } });
    expect(r.ok).toBe(false);
    expect(String(r.text)).toContain("pas de réponse");
    // Le serveur répond après 1,5 s (plus sur une machine chargée) : open() aboutit alors, puis est refermé. On attend ce
    // moment-là (borné), au lieu d'un délai fixe.
    expect(await waitGone(pidFile, 12_000)).toBe(true);
  }, 20_000);
});
