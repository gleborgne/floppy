// Serveur MCP local « Floppy » (HTTP streamable, 127.0.0.1 seulement, jeton obligatoire).
// Il expose TOUS les outils du registre du noyau aux cerveaux CLI (Claude, Codex).
// Chaque appel passe par ToolRegistry.call : même règle, même accord, même journal que l'agent AI SDK.
// Repris de prototypes/cli-brain/src/floppy-mcp.ts.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "@floppy/core";
import type { ExtraTool, McpEndpoint, ScopedEndpoint, ScopedOptions } from "@floppy/contracts";
import { TurnContexts } from "./turn-context.ts";

interface Scope { tools: Set<string>; extra: Map<string, ExtraTool>; contexts: TurnContexts }

const MAX_BODY = 4 * 1024 * 1024;

/** Arguments pour le journal : les champs qui ressemblent à un secret sont masqués. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = /token|secret|passw|mot_?de_?passe|pass|key|cle|clé|authorization|bearer|credential/i.test(k) ? "[masqué]" : v;
  return out;
}

export async function startFloppyMcp(ctx: Context, port: number): Promise<McpEndpoint> {
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);

  const scopes = new Map<string, Scope>(); // jeton restreint -> portée
  const contexts = new TurnContexts();
  ctx.effect(() => { contexts.close(); for (const s of scopes.values()) s.contexts.close(); scopes.clear(); });

  const makeServer = (scope?: Scope): Server => {
    const context = (scope?.contexts ?? contexts).snapshot();
    const server = new Server({ name: "floppy", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...ctx.tools.list().filter((t) => !scope || scope.tools.has(t.name)).map((t): Tool => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Tool["inputSchema"],
          annotations: { readOnlyHint: t.level === "read", destructiveHint: t.level === "delete" },
        })),
        ...[...(scope?.extra.values() ?? [])].map((t): Tool => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema as Tool["inputSchema"],
        })),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (scope) {
        const extra = scope.extra.get(req.params.name);
        if (extra) {
          // Ces outils sont hors du registre du noyau : on écrit nous-mêmes l'entrée de journal (sans champs secrets).
          const args = (req.params.arguments ?? {}) as Record<string, unknown>;
          const t0 = performance.now();
          let r: { text: string; isError?: boolean };
          try { r = await extra.handler(args); } catch (e) { r = { text: `Erreur de l'outil ${extra.name} : ${e instanceof Error ? e.message : String(e)}`, isError: true }; }
          ctx.audit.write({ kind: "tool", tool: extra.name, source: "mcp.scoped", args: redact(args), status: r.isError ? "failed" : "done", ms: Math.round(performance.now() - t0), caller: "mcp" });
          return { content: [{ type: "text", text: r.text }], isError: r.isError ?? false };
        }
        if (!scope.tools.has(req.params.name)) {
          ctx.audit.write({ kind: "mcp.scope_refused", tool: req.params.name });
          return { content: [{ type: "text", text: "Outil inconnu." }], isError: true };
        }
      }
      const r = await ctx.tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, { caller: "mcp", ...context });
      return { content: [{ type: "text", text: r.text }], isError: r.status !== "done" && r.status !== "unverified" };
    });
    return server;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!req.url?.startsWith("/mcp")) { res.statusCode = 404; res.end(); return; }
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    let scope: Scope | undefined;
    let ok = got.length === want.length && timingSafeEqual(got, want);
    if (!ok) {
      for (const [t, sc] of scopes) {
        const w = Buffer.from(`Bearer ${t}`);
        if (got.length === w.length && timingSafeEqual(got, w)) { scope = sc; ok = true; break; }
      }
    }
    if (!ok) {
      ctx.audit.write({ kind: "mcp.auth_refused", method: req.method, ua: String(req.headers["user-agent"] ?? "") });
      res.statusCode = 401; res.end(); return;
    }
    if (req.method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST"); res.end(); return; }
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > MAX_BODY) { res.statusCode = 413; res.end(); return; }
    }
    // Mode sans session : un serveur et un transport par requête (les outils n'ont pas d'état ici).
    const server = makeServer(scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((e) => {
      ctx.log("error", `serveur MCP : ${String(e)}`);
      if (!res.headersSent) { res.statusCode = 500; res.end(); }
    });
  });
  await new Promise<void>((ok, ko) => { http.once("error", ko); http.listen(port, "127.0.0.1", ok); });
  ctx.effect(async () => {
    await new Promise<void>((ok) => http.close(() => ok()));
    http.closeAllConnections();
  });
  const actual = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${actual}/mcp`;
  const scoped = (opts: ScopedOptions): ScopedEndpoint => {
    const t = randomBytes(24).toString("hex");
    const scopedContexts = new TurnContexts();
    scopes.set(t, { tools: new Set(opts.tools), extra: new Map((opts.extraTools ?? []).map((e) => [e.name, e])), contexts: scopedContexts });
    return { url, token: t, bindContext: context => scopedContexts.bind(context), close: () => { scopedContexts.close(); scopes.delete(t); } };
  };
  return { url, token, scoped, bindContext: context => contexts.bind(context) };
}
