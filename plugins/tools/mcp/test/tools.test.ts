// Tests de P2 : niveaux, accords, serveur MCP Floppy. Inspirés des tests d'attaque de prototypes/bridge/.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Kernel, MemoryAudit } from "@floppy/core";
import tools, { resolveLevel, type McpEndpoint } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const calls = join(mkdtempSync(join(tmpdir(), "mcp-")), "calls.jsonl");
const reached = (): string[] => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).tool) : [];

describe("niveaux", () => {
  it("config > annotations > inconnu = write ; motif exact avant joker", () => {
    expect(resolveLevel("x", {}, { readOnlyHint: true })).toEqual({ level: "read" });
    expect(resolveLevel("x", {}, { destructiveHint: true })).toEqual({ level: "delete" });
    expect(resolveLevel("x", {})).toEqual({ level: "write" });
    expect(resolveLevel("write_file", { "write_*": "never" }, { readOnlyHint: true })).toEqual({ level: "write", rule: "never" });
    expect(resolveLevel("write_file", { "write_*": "never", write_file: "read" })).toEqual({ level: "read" });
  });
});

describe("plugin tools", () => {
  const audit = new MemoryAudit();
  const k = new Kernel({ logger: () => {}, audit, plugins: [tools] });
  let mcp: McpEndpoint;
  let answer: boolean | "silence" = true;

  beforeAll(async () => {
    await k.applyConfig({
      approvals: { timeout_s: 1 },
      plugins: [{
        id: "tools", plugin: "tools",
        config: {
          port: 0,
          servers: {
            fake: { command: process.execPath, args: [join(here, "fixtures", "fake-mcp.mjs")], env: { CALLS_LOG: calls }, levels: { "write_*": "never" } },
            casse: { command: "commande-qui-n-existe-pas-xyz" },
          },
        },
      }],
    });
    await k.service<McpEndpoint>("mcp")?.connected?.();
    // Le « corps » de test : répond aux demandes d'accord.
    k.bus.on("approval.request", (r) => { if (answer !== "silence") k.approvals.respond(r.id, answer, "test"); });
    mcp = k.service<McpEndpoint>("mcp")!;
  });
  afterAll(() => k.stopAll());

  it("démarre malgré un serveur MCP cassé, et l'inscrit au journal", () => {
    expect(k.status()[0]?.state).toBe("active");
    expect(audit.records.some((r) => r.kind === "mcp.server_failed" && r.server === "casse")).toBe(true);
    expect(k.tools.list().filter((t) => t.source !== "core").map((t) => [t.name, t.level])).toEqual([
      ["lire_note", "read"], ["ecrire_note", "write"], ["supprimer_note", "delete"], ["write_file", "write"], ["planter", "read"],
    ]);
  });

  it("lecture : libre, sans demande d'accord", async () => {
    const r = await k.tools.call("lire_note", { texte: "a" });
    expect(r).toMatchObject({ status: "done", text: "ok lire_note" });
  });

  it("écriture refusée : n'atteint JAMAIS le serveur MCP", async () => {
    answer = false;
    const before = reached().length;
    const r = await k.tools.call("ecrire_note", { texte: "b" });
    expect(r.status).toBe("refused");
    expect(r.text).toMatch(/Ne la retente pas/);
    expect(reached().length).toBe(before);
  });

  it("pas de réponse : refus après le délai, rien n'atteint le serveur", async () => {
    answer = "silence";
    const before = reached().length;
    const r = await k.tools.call("supprimer_note", {});
    expect(r.status).toBe("refused");
    expect(reached().length).toBe(before);
  });

  it("écriture accordée : exécutée et journalisée", async () => {
    answer = true;
    const r = await k.tools.call("ecrire_note", { texte: "c" });
    expect(r.status).toBe("done");
    expect(reached().at(-1)).toBe("ecrire_note");
    expect(audit.records.filter((x) => x.kind === "tool").at(-1)).toMatchObject({ tool: "ecrire_note", status: "done", level: "write" });
  });

  it("motif never : refusé sans même demander, même si l'outil se dit en lecture", async () => {
    answer = true;
    const asked: unknown[] = [];
    const off = k.bus.on("approval.request", (r) => asked.push(r));
    const r = await k.tools.call("write_file", {});
    off();
    expect(r.status).toBe("refused");
    expect(asked).toHaveLength(0);
    expect(reached()).not.toContain("write_file");
  });

  it("erreur du serveur MCP : statut failed", async () => {
    expect((await k.tools.call("planter", {})).status).toBe("failed");
  });

  it("outil inconnu : failed", async () => {
    expect((await k.tools.call("rm_rf", {})).status).toBe("failed");
  });

  it("serveur MCP Floppy : sans jeton = 401", async () => {
    const r = await fetch(mcp.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    const r2 = await fetch(mcp.url, { method: "POST", headers: { Authorization: "Bearer mauvais-jeton-de-meme-longueur-000000000000" }, body: "{}" });
    expect(r2.status).toBe(401);
  });

  it("serveur MCP Floppy : avec jeton, liste et appel passent par le même accord", async () => {
    const client = new Client({ name: "test-cli", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } } }));
    try {
      const { tools: list } = await client.listTools();
      expect(list.map((t) => t.name)).toContain("lire_note");
      expect(list.find((t) => t.name === "lire_note")?.annotations?.readOnlyHint).toBe(true);
      answer = false;
      const before = reached().length;
      const r = await client.callTool({ name: "ecrire_note", arguments: { texte: "d" } });
      expect(r.isError).toBe(true);
      expect(reached().length).toBe(before);
      expect(audit.records.filter((x) => x.kind === "tool").at(-1)).toMatchObject({ tool: "ecrire_note", caller: "mcp", status: "refused" });
    } finally {
      await client.close();
    }
  });
});
