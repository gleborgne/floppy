// Découverte sans tour de modèle : initialise le protocole du CLI, lit son catalogue, puis ferme le processus.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree, type Context } from "@floppy/core";
import type { AgentModel } from "./model-catalog.ts";

export interface ModelDiscoveryCommand {
  exe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function modelRows(rows: unknown, idKey: string, labelKey: string): AgentModel[] {
  if (!Array.isArray(rows)) throw new Error("catalogue invalide");
  const models = new Map<string, AgentModel>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.hidden === true) continue;
    const id = row[idKey], label = row[labelKey];
    if (typeof id === "string" && id.trim() && typeof label === "string" && label.trim()) models.set(id, { id, label });
  }
  return [...models.values()];
}

/** JSONL borné, une seule requête à la fois ; aucune requête du serveur n'est exécutée. */
async function withJsonLines<T>(ctx: Context, cmd: ModelDiscoveryCommand,
  run: (exchange: (message: object, match: (reply: any) => boolean) => Promise<any>, send: (message: object) => void) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(cmd.timeoutMs ?? 15_000);
  const p = ctx.spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: cmd.env, windowsHide: true, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
  let waiting: { match: (reply: any) => boolean; resolve: (reply: any) => void; reject: (e: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => { failure = error; waiting?.reject(error); waiting = undefined; };
  const abort = () => fail(new Error("délai de découverte dépassé"));
  signal.addEventListener("abort", abort, { once: true });
  const dispose = ctx.effect(async () => { fail(new Error("découverte arrêtée")); await killTree(p); });
  p.on("error", fail);
  p.on("exit", () => fail(new Error("programme arrêté avant le catalogue")));
  p.stdin.on("error", fail);
  p.stderr.resume();
  const lines = createInterface({ input: p.stdout });
  let bytes = 0;
  p.stdout.on("data", (data) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) fail(new Error("catalogue trop volumineux")); });
  lines.on("line", (line) => {
    let reply: any;
    try { reply = JSON.parse(line); } catch { return; }
    if (waiting?.match(reply)) { const w = waiting; waiting = undefined; w.resolve(reply); }
  });
  const send = (message: object) => p.stdin.write(JSON.stringify(message) + "\n");
  try {
    return await run((message, match) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting = { match, resolve, reject };
      send(message);
    }), send);
  } finally {
    signal.removeEventListener("abort", abort);
    lines.close();
    await dispose();
  }
}

export function discoverCodexModels(ctx: Context, cmd: ModelDiscoveryCommand): Promise<AgentModel[]> {
  return withJsonLines(ctx, cmd, async (exchange, send) => {
    let id = 0;
    const request = async (method: string, params: object) => {
      const requestId = ++id;
      const reply = await exchange({ id: requestId, method, params }, (r) => r.id === requestId && !r.method);
      if (reply.error) throw new Error("Codex refuse la découverte");
      return reply.result;
    };
    await request("initialize", { clientInfo: { name: "floppy", version: "0.1.0" } });
    send({ method: "initialized" });
    const models: AgentModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...modelRows(result?.data, "model", "displayName"));
      cursor = result?.nextCursor ?? undefined;
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 100)) throw new Error("pagination invalide");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Map(models.map((m) => [m.id, m])).values()];
  });
}

export function discoverClaudeModels(ctx: Context, cmd: ModelDiscoveryCommand): Promise<AgentModel[]> {
  return withJsonLines(ctx, cmd, async (exchange) => {
    const reply = await exchange({ type: "control_request", request_id: "floppy-models", request: { subtype: "initialize" } },
      (r) => r.type === "control_response" && r.response?.request_id === "floppy-models");
    if (reply.response.subtype !== "success") throw new Error("Claude refuse la découverte");
    return modelRows(reply.response.response?.models, "value", "displayName");
  });
}

export async function discoverAgyModels(ctx: Context, cmd: ModelDiscoveryCommand): Promise<AgentModel[]> {
  const { stdout } = await ctx.exec(cmd.exe, cmd.args, { cwd: cmd.cwd, env: cmd.env, timeoutMs: cmd.timeoutMs ?? 15_000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (result.status !== "SUCCESS") throw new Error("Antigravity refuse la découverte");
  return modelRows(result.command?.data?.models, "id", "label");
}
