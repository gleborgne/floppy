// Plugin `bench-api` (dev) : expose le cerveau en /v1/chat/completions (flux OpenAI + événements
// hermes.tool.progress), pour réutiliser tel quel le banc des prototypes 3 à 5 (40 demandes notées).
// - En-tête X-Approval : auto | deny → réponse automatique aux demandes d'accord pendant la requête.
// - Chaque demande d'accord est écrite dans approvalsLog (lu par la notation des cas « écriture refusée »).
// Port de prototypes/cli-brain/src/serve.ts. 127.0.0.1 seulement.
import { z } from "zod";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { definePlugin } from "@floppy/core";

const Config = z.object({
  port: z.number().int().default(8741),
  approvalsLog: z.string().optional(),
  /** Préfixe des outils dans les événements (la notation attend mcp__work_tools__<outil>). */
  toolPrefix: z.string().default("mcp__work_tools__"),
});
type Config = z.infer<typeof Config>;

export default definePlugin<Config>({
  manifest: {
    id: "bench-api",
    version: "0.1.0",
    licence: "MIT",
    description: "Banc de test : le cerveau en API compatible OpenAI (dev seulement).",
    inject: ["brain"],
    permissions: { approvals: "respond" },
  },
  config: Config,
  async apply(ctx, cfg) {
    const brain = ctx.get("brain");
    if (cfg.approvalsLog) mkdirSync(dirname(cfg.approvalsLog), { recursive: true });
    // Politique par requête : l'origine du tour est « bench-N » (une par requête), seules ces demandes sont auto-répondues.
    const policies = new Map<string, "auto" | "deny">();
    let n = 0;

    ctx.on("approval.request", (r) => {
      const policy = r.origin ? policies.get(r.origin) : undefined;
      if (!policy) return;
      if (cfg.approvalsLog) appendFileSync(cfg.approvalsLog, JSON.stringify({ t: Date.now() / 1000, tool: r.tool, args: r.args, approved: policy === "auto" }) + "\n");
      ctx.approvals.respond(r.id, policy === "auto", "bench");
    });

    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.statusCode = 404; res.end(); return; }
      let prompt: string;
      try {
        let body = "";
        for await (const c of req) body += c;
        const parsed = JSON.parse(body) as { messages?: unknown } | null;
        const msgs = (Array.isArray(parsed?.messages) ? parsed.messages : []) as { role?: unknown; content?: unknown }[];
        const last = [...msgs].reverse().find((m) => m && m.role === "user")?.content;
        prompt = typeof last === "string" ? last : "";
      } catch {
        res.statusCode = 400; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "JSON invalide" }));
        return;
      }
      const session = `bench-${++n}`;
      policies.set(session, String(req.headers["x-approval"] ?? "deny") === "auto" ? "auto" : "deny");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (obj: unknown, event?: string) => res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(obj)}\n\n`);
      // Le client coupe : le tour du cerveau s'arrête aussi (sinon il continue et peut même agir pour personne).
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableFinished) abort.abort(); });
      try {
        for await (const ev of brain.run({ text: prompt, session, mode: "voice", origin: session, signal: abort.signal })) {
          if (abort.signal.aborted) break;
          if (ev.type === "text") send({ choices: [{ index: 0, delta: { content: ev.delta } }] });
          else if (ev.type === "tool") send({ tool: `${cfg.toolPrefix}${ev.name}`, status: "running" }, "hermes.tool.progress");
          else if (ev.type === "emotion") send({ emotion: ev.emotion }, "floppy.emotion");
          else if (ev.type === "done") send({ info: ev.info }, "floppy.done");
        }
      } catch (e) {
        ctx.log("error", `tour du banc : ${String(e)}`);
        send({ error: String(e) }, "floppy.error");
      } finally {
        brain.reset(session);
        policies.delete(session);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(cfg.port, "127.0.0.1", ok); });
    ctx.effect(async () => { await new Promise<void>((ok) => server.close(() => ok())); server.closeAllConnections(); });
    ctx.log("info", `banc prêt : http://127.0.0.1:${cfg.port}/v1`);
  },
});
