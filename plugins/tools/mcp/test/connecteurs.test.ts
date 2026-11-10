// Tests des connecteurs : filtre include, bascule à chaud, accord pour un connecteur cloud, serveur MCP distant (HTTP).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Kernel, MemoryAudit } from "@floppy/core";
import type { McpEndpoint } from "@floppy/contracts";
import tools from "../src/index.ts";
import { parseAzToken, azTokenProvider, bearerFetch } from "../src/azcli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const calls = join(mkdtempSync(join(tmpdir(), "mcp-conn-")), "calls.jsonl");
const fakeServer = (extra: Record<string, unknown> = {}) => ({
  command: process.execPath, args: [join(here, "fixtures", "fake-mcp.mjs")], env: { CALLS_LOG: calls }, ...extra,
});
const enable = (k: Kernel, id: string, on: boolean, via: "cli" | "voice" = "cli") => k.items.run({ op: "enable", provider: "connectors", id, on }, via);
const info = async (k: Kernel, id: string) => (await k.items.provider("connectors")!.list()).find((i) => i.id === id)!;
const mine = (k: Kernel): string[] => k.tools.list().filter((t) => t.source !== "core").map((t) => t.name);

describe("connecteurs : include et bascule à chaud", () => {
  const audit = new MemoryAudit();
  const k = new Kernel({ logger: () => {}, audit, plugins: [tools], home: mkdtempSync(join(tmpdir(), "mcp-home-")) });
  let answer = true;
  beforeAll(async () => {
    await k.applyConfig({
      approvals: { timeout_s: 1 },
      plugins: [{
        id: "tools", plugin: "tools",
        config: {
          port: 0,
          servers: {
            fake: fakeServer({ include: ["*_note", "planter"], exclude: ["supprimer_*"], label: "Faux" }),
            nuage: fakeServer({ cloud: true, disabled: true, include: ["supprimer_note"] }),
          },
        },
      }],
    });
    await k.service<McpEndpoint>("mcp")?.connected?.();
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, answer, "test"); });
  });
  afterAll(() => k.stopAll());

  it("include s'applique avant exclude ; un serveur désactivé reste éteint", async () => {
    expect(mine(k)).toEqual(["lire_note", "ecrire_note", "planter"]);
    const n = await info(k, "nuage");
    expect(n).toMatchObject({ enabled: false, status: "off", cloud: true, kind: "mcp-local" });
    const f = await info(k, "fake");
    expect(f).toMatchObject({ label: "Faux", enabled: true, status: "ok" });
    expect(f.statusText).toEqual({ fr: "connecté · 3 outils sur 5", en: "connected · 3 tools of 5" });
    expect(f.children!.filter((c) => c.enabled).map((c) => c.id)).toEqual(["lire_note", "ecrire_note", "planter"]);
    expect(f.children!.find((c) => c.id === "lire_note")!.tag).toEqual({ fr: "lecture · libre", en: "read · free" });
  });

  it("éteindre retire les outils, rallumer les remet", async () => {
    expect((await enable(k, "fake", false)).ok).toBe(true);
    expect(mine(k)).toEqual([]);
    expect(audit.records.some((r) => r.kind === "mcp.server_down")).toBe(false);
    expect((await enable(k, "fake", true)).ok).toBe(true);
    expect(mine(k)).toEqual(["lire_note", "ecrire_note", "planter"]);
    expect((await k.tools.call("lire_note", {})).status).toBe("done");
  });

  it("connecteur cloud : l'allumer à la voix demande un accord ; refusé = reste éteint", async () => {
    answer = false;
    const asked: unknown[] = [];
    const off = k.bus.on("approval.request", (r) => asked.push(r));
    const r = await enable(k, "nuage", true, "voice");
    expect(asked).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect((await info(k, "nuage")).enabled).toBe(false);
    answer = true;
    await enable(k, "nuage", true, "voice");
    expect((await info(k, "nuage")).enabled).toBe(true);
    // L'éteindre est libre : aucune demande.
    answer = false;
    const before = asked.length;
    await enable(k, "nuage", false, "voice");
    off();
    expect(asked.length).toBe(before);
    expect((await info(k, "nuage")).enabled).toBe(false);
  });
});

describe("serveur MCP distant (HTTP)", () => {
  let http: HttpServer;
  const seen: string[] = [];
  const k = new Kernel({ logger: () => {}, audit: new MemoryAudit(), plugins: [tools], home: mkdtempSync(join(tmpdir(), "mcp-home-")) });

  beforeAll(async () => {
    http = createServer((req, res) => {
      void (async () => {
        seen.push(String(req.headers.authorization ?? ""));
        if (req.headers.authorization !== "Bearer secret-de-test") { res.statusCode = 401; res.end(); return; }
        let body = "";
        for await (const c of req) body += c;
        const server = new McpServer({ name: "distant", version: "0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            { name: "wit_get", description: "Lit.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
            { name: "wit_write", description: "Écrit.", inputSchema: { type: "object" } },
            { name: "autre", description: "Hors filtre.", inputSchema: { type: "object" } },
          ],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: `distant ${r.params.name}` }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } });
    });
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
    await k.applyConfig({
      plugins: [{
        id: "tools", plugin: "tools",
        config: { port: 0, servers: { distant: { url, headers: { Authorization: "Bearer secret-de-test" }, include: ["wit_*"], cloud: true, trust_annotations: true } } },
      }],
    });
    await k.service<McpEndpoint>("mcp")?.connected?.();
  });
  afterAll(async () => { await k.stopAll(); http.closeAllConnections(); await new Promise<void>((ok) => http.close(() => ok())); });

  it("se connecte avec les en-têtes, expose les outils filtrés et les appelle", async () => {
    expect(mine(k)).toEqual(["wit_get", "wit_write"]);
    expect(k.tools.list().find((t) => t.name === "wit_get")?.level).toBe("read");
    expect(await k.tools.call("wit_get", {})).toMatchObject({ status: "done", text: "distant wit_get" });
    expect(seen.every((h) => h === "Bearer secret-de-test")).toBe(true);
  });

  it("éteint puis rallumé", async () => {
    await enable(k, "distant", false);
    expect(mine(k)).toEqual([]);
    await enable(k, "distant", true);
    expect(mine(k)).toEqual(["wit_get", "wit_write"]);
  });
});

describe("jeton azcli", () => {
  it("lit expires_on (secondes) ou expiresOn", () => {
    expect(parseAzToken(JSON.stringify({ accessToken: "t", expires_on: 2000000000 }))).toEqual({ token: "t", expiresAt: 2000000000000 });
    expect(parseAzToken(JSON.stringify({ accessToken: "t", expiresOn: "2033-05-18 03:33:20.000000" })).token).toBe("t");
    expect(() => parseAzToken("{}")).toThrow();
  });

  it("garde le jeton en cache et le renouvelle 5 minutes avant la fin", async () => {
    let n = 0;
    const exp = [Date.now() / 1000 + 3600, Date.now() / 1000 + 120, Date.now() / 1000 + 3600];
    const get = azTokenProvider("https://x", async () => JSON.stringify({ accessToken: `t${n}`, expires_on: exp[n++] }));
    expect(await get()).toBe("t0");
    expect(await get()).toBe("t0");
    expect(n).toBe(1);
    // Le jeton suivant expire dans 2 minutes : jugé trop proche, donc refait à chaque appel.
    n = 1;
    expect(await azTokenProvider("https://x", async () => JSON.stringify({ accessToken: "a", expires_on: exp[1] }))()).toBe("a");
  });
});

describe("requêtes d'un serveur distant", () => {
  it("bearerFetch ajoute le jeton puis passe par le fetch donné (celui du contexte)", async () => {
    const seen: { url: string; auth: string | null; timeoutMs?: number }[] = [];
    const http = (async (url: string | URL, init?: RequestInit & { timeoutMs?: number }) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), ...(init?.timeoutMs ? { timeoutMs: init.timeoutMs } : {}) });
      return new Response("ok");
    }) as typeof fetch;
    const r = await bearerFetch(async () => "tok", http)("https://mcp.contoso.com/x", { method: "POST", timeoutMs: 5 } as RequestInit);
    expect(await r.text()).toBe("ok");
    expect(seen).toEqual([{ url: "https://mcp.contoso.com/x", auth: "Bearer tok", timeoutMs: 5 }]);
  });
});

describe("serveur distant : « lecture seule » cru seulement sur confiance", () => {
  it("sans confiance, un outil « lecture seule » d'un serveur distant demande l'accord ; « destructif » compte toujours", async () => {
    const { resolveLevel } = await import("../src/levels.ts");
    expect(resolveLevel("x", {}, { readOnlyHint: true }, false)).toEqual({ level: "write" });
    expect(resolveLevel("x", {}, { readOnlyHint: true }, true)).toEqual({ level: "read" });
    expect(resolveLevel("x", {}, { readOnlyHint: true, destructiveHint: true }, true)).toEqual({ level: "delete" });
    expect(resolveLevel("x", { x: "read" }, {}, false)).toEqual({ level: "read" }); // la config de l'utilisateur passe avant
  });
});
