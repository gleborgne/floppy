// Accès MCP restreint : un jeton restreint ne liste et n'appelle que ses outils.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Kernel, MemoryAudit } from "@floppy/core";
import tools, { type McpEndpoint } from "../src/index.ts";

async function connect(url: string, token: string): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: any): string => (r.content as { text: string }[]).map((x) => x.text).join("");

describe("serveur MCP restreint", () => {
  const audit = new MemoryAudit();
  const k = new Kernel({ logger: () => {}, audit, plugins: [tools] });
  const reached: string[] = [];
  let mcp: McpEndpoint;

  beforeAll(async () => {
    await k.applyConfig({ plugins: [{ id: "tools", plugin: "tools", config: { port: 0 } }] });
    k.tools.register("test", [
      { name: "outil_a", description: "a", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => { reached.push("a"); return { status: "done", text: "A" }; } },
      { name: "outil_b", description: "b", inputSchema: { type: "object", properties: {} }, level: "read", handler: async () => { reached.push("b"); return { status: "done", text: "B" }; } },
      { name: "contexte", description: "contexte hôte", inputSchema: { type: "object", properties: {} }, level: "read", handler: async (_args, meta) => ({ status: "done", text: JSON.stringify({ session: meta.session ?? null, origin: meta.origin ?? null }) }) },
    ]);
    mcp = k.service<McpEndpoint>("mcp")!;
  });
  afterAll(() => k.stopAll());

  it("le jeton complet voit tout", async () => {
    const c = await connect(mcp.url, mcp.token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("outil_a");
    expect(names).toContain("outil_b");
    await c.close();
  });

  it("transmet le contexte hôte, ignore la session du modèle et isole les jetons", async () => {
    const master = await connect(mcp.url, mcp.token);
    const scoped = mcp.scoped({ tools: ["contexte"] });
    const child = await connect(scoped.url, scoped.token);
    const release = mcp.bindContext!({ session: "avatar", origin: "micro" });
    try {
      expect(JSON.parse(text(await master.callTool({ name: "contexte", arguments: { session: "invente", origin: "autre" } })))).toEqual({ session: "avatar", origin: "micro" });
      expect(JSON.parse(text(await child.callTool({ name: "contexte", arguments: {} })))).toEqual({ session: null, origin: null });
      const childRelease = scoped.bindContext!({ session: "mission", origin: "chat" });
      expect(JSON.parse(text(await child.callTool({ name: "contexte", arguments: {} })))).toEqual({ session: "mission", origin: "chat" });
      childRelease();
      const conflict = mcp.bindContext!({ session: "autre", origin: "chat" });
      expect(JSON.parse(text(await master.callTool({ name: "contexte", arguments: {} })))).toEqual({ session: null, origin: null });
      conflict();
    } finally { release(); await master.close(); await child.close(); scoped.close(); }
    const fresh = await connect(mcp.url, mcp.token);
    try { expect(JSON.parse(text(await fresh.callTool({ name: "contexte", arguments: {} })))).toEqual({ session: null, origin: null }); }
    finally { await fresh.close(); }
  });

  it("un jeton restreint ne liste que ses outils (et les outils en mémoire)", async () => {
    const s = mcp.scoped({
      tools: ["outil_a", "absent"],
      extraTools: [{ name: "permission", description: "p", inputSchema: { type: "object", properties: {} }, handler: async (a) => ({ text: `ok ${JSON.stringify(a)}` }) }],
    });
    const c = await connect(s.url, s.token);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["outil_a", "permission"]);
    expect(text(await c.callTool({ name: "outil_a", arguments: {} }))).toBe("A");
    expect(text(await c.callTool({ name: "permission", arguments: { x: 1 } }))).toBe('ok {"x":1}');
    await c.close();
  });

  it("un outil supplémentaire est journalisé (sans champs secrets)", async () => {
    const s = mcp.scoped({
      tools: [],
      extraTools: [
        { name: "extra_ok", description: "e", inputSchema: { type: "object", properties: {} }, handler: async () => ({ text: "fait" }) },
        { name: "extra_ko", description: "e", inputSchema: { type: "object", properties: {} }, handler: async () => ({ text: "raté", isError: true }) },
      ],
    });
    const c = await connect(s.url, s.token);
    await c.callTool({ name: "extra_ok", arguments: { x: 1, api_token: "SECRET123" } });
    await c.callTool({ name: "extra_ko", arguments: {} });
    await c.close();
    const ok = audit.records.find((x) => x.kind === "tool" && x.tool === "extra_ok")!;
    expect(ok.status).toBe("done");
    expect(typeof ok.ms).toBe("number");
    expect(JSON.stringify(ok)).not.toContain("SECRET123");
    expect((ok.args as Record<string, unknown>).x).toBe(1);
    expect(audit.records.find((x) => x.kind === "tool" && x.tool === "extra_ko")!.status).toBe("failed");
  });

  it("un jeton restreint ne peut pas appeler un autre outil", async () => {
    const s = mcp.scoped({ tools: ["outil_a"] });
    const c = await connect(s.url, s.token);
    const r = await c.callTool({ name: "outil_b", arguments: {} });
    expect(r.isError).toBe(true);
    expect(reached).not.toContain("b");
    expect(audit.records.some((x) => x.kind === "mcp.scope_refused" && x.tool === "outil_b")).toBe(true);
    await c.close();
  });

  it("close() révoque le jeton ; un faux jeton est refusé", async () => {
    const s = mcp.scoped({ tools: ["outil_a"] });
    s.close();
    await expect(connect(s.url, s.token)).rejects.toThrow();
    await expect(connect(mcp.url, "faux")).rejects.toThrow();
  });
});
