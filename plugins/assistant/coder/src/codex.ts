// Agent Codex : `codex app-server` (JSON-RPC sur stdin/stdout), un fil (thread) par conversation.
// Les demandes d'accord de Codex (modifier un fichier, lancer une commande) deviennent des demandes à l'utilisateur.
// Port de CodexBrain (prototypes/cli-brain/src/brains.ts).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killTree, type CoderMode } from "@floppy/core";
import { cleanEnv, isInside, say, short, signInMessage, SIGN_IN_RE, type Runner, type RunnerDeps } from "./common.ts";

export interface CodexOptions {
  exe: string;
  exeArgs?: string[];
  mode: CoderMode;
  cwd: string;
  system: string;
  mcpUrl: string;
  mcpToken: string;
  mcpTools: string[];
  /** Dossier des plugins (mode plugin) : tout chemin hors de ce dossier est refusé. */
  pluginsDir: string;
}

/** Serveurs MCP déclarés dans ~/.codex/config.toml (lu seulement) : on les coupe par des surcharges -c. */
function userCodexMcpNames(): string[] {
  try {
    const toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    return [...toml.matchAll(/^\[mcp_servers\.([^.\]\s]+)\]/gm)].map((m) => m[1]!.replace(/^["']|["']$/g, ""));
  } catch { return []; }
}

export function codexOverrides(o: Pick<CodexOptions, "mode" | "mcpUrl" | "mcpTools">, userMcp: string[] = userCodexMcpNames()): string[] {
  const off = ["plugins", "apps", "hooks", "browser_use", "browser_use_external", "computer_use",
    "image_generation", "multi_agent", "view_image", "goals", "tool_suggest", "skill_search", "sleep_tool", "memories",
    "in_app_browser", "skill_mcp_dependency_install", "workspace_dependencies", "remote_plugin"];
  // Mode réglages : pas de shell du tout. Mode plugin : le shell reste, mais chaque commande demande l'accord.
  if (o.mode === "reglages") off.push("shell_tool", "unified_exec");
  const c: string[] = [];
  for (const f of off) c.push("-c", `features.${f}=false`);
  for (const n of userMcp) c.push("-c", `mcp_servers.${n}.enabled=false`);
  // Nos outils passent sans question côté Codex : le noyau tient lui-même l'accord (réglages) ou l'outil est sans risque.
  const approve = o.mcpTools.map((t) => `${t}={approval_mode="approve"}`).join(",");
  c.push("-c", `mcp_servers.floppy={url="${o.mcpUrl}",bearer_token_env_var="FLOPPY_MCP_TOKEN",tools={${approve}}}`);
  c.push("-c", 'web_search="disabled"',
    "-c", "skills.include_instructions=false", "-c", "tools.update_plan.enabled=false",
    "-c", "tools.experimental_request_user_input.enabled=false", "-c", "features.multi_agent_v2=false", "-c", "project_doc_max_bytes=32768",
    "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false");
  return c;
}

export class CodexRunner implements Runner {
  private o: CodexOptions;
  private d: RunnerDeps;
  private p?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private ready: Promise<string>;
  private threadId?: string;
  private turnId?: string;
  private busy = false;
  private closed = false;
  private stderr = "";
  private lastError = "";
  private lastItemText?: string;
  private sawText = false;
  private changes = new Map<string, { path: string; diff: string }[]>();

  constructor(o: CodexOptions, d: RunnerDeps) {
    this.o = o; this.d = d;
    this.d.emit({ type: "status", status: "starting" });
    this.ready = this.boot();
    this.ready.then(() => this.d.emit({ type: "status", status: "ready" }), (e) => {
      this.d.log("error", `codex : ${e.message}`);
    });
  }

  private write(obj: object): void { this.p?.stdin.write(JSON.stringify(obj) + "\n"); }
  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((ok, err) => this.pending.set(id, { ok, err }));
  }

  private async boot(): Promise<string> {
    const o = this.o;
    const p = spawn(o.exe, [...(o.exeArgs ?? []), "app-server", ...codexOverrides(o)], {
      cwd: o.cwd, windowsHide: true, env: cleanEnv({ FLOPPY_MCP_TOKEN: o.mcpToken, RUST_LOG: "warn" }),
    });
    this.p = p;
    p.stdin.on("error", () => {});
    p.stderr.on("data", (b) => { this.stderr = (this.stderr + String(b)).slice(-2000); this.d.log("debug", `codex : ${String(b).slice(0, 300)}`); });
    p.on("error", (e) => { if (this.p === p) this.onExit(say(this.d.lang, `Impossible de lancer Codex : ${e.message}`, `Cannot start Codex: ${e.message}`)); });
    p.on("exit", () => { if (this.p === p) this.onExit(this.stderr.trim().split("\n").pop() || say(this.d.lang, "Le processus Codex s'est arrêté.", "The Codex process stopped.")); });
    createInterface({ input: p.stdout }).on("line", (l) => {
      let m: any;
      try { m = JSON.parse(l); } catch { return; }
      if (m.id !== undefined && m.method) void this.onServerRequest(m);
      else if (m.id !== undefined) {
        const w = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) w?.err(new Error(m.error.message ?? JSON.stringify(m.error))); else w?.ok(m.result);
      } else if (m.method) this.onNotification(m);
    });
    await this.request("initialize", { clientInfo: { name: "floppy", title: "Floppy", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.write({ jsonrpc: "2.0", method: "initialized" });
    const plugin = o.mode === "plugin";
    // « untrusted » : seules les commandes de lecture connues passent seules ; toute modification de fichier et toute
    // autre commande reviennent en demande d'accord (item/*/requestApproval), traitée par onServerRequest.
    const r = await this.request("thread/start", {
      cwd: o.cwd, approvalPolicy: plugin ? "untrusted" : "never", sandbox: plugin ? "workspace-write" : "read-only",
      baseInstructions: o.system, ephemeral: true, approvalsReviewer: "user",
    });
    this.threadId = r.thread.id;
    return r.thread.id;
  }

  private onExit(text: string): void {
    for (const w of this.pending.values()) w.err(new Error(text));
    this.pending.clear();
    this.p = undefined;
    if (this.busy) this.finish("error", text);
  }

  private finish(stop: "end" | "error" | "cancelled", error?: string): void {
    if (!this.busy) return;
    this.busy = false;
    if (stop === "error") {
      const signIn = SIGN_IN_RE.test(`${error ?? ""} ${this.lastError} ${this.stderr}`);
      this.d.emit({ type: "done", stopReason: "error", error: signIn ? signInMessage("codex", this.d.lang) : error ?? say(this.d.lang, "erreur", "error"), ...(signIn ? { signIn: true } : {}) });
    } else {
      this.d.emit({ type: "done", stopReason: stop });
    }
    if (this.p) this.d.emit({ type: "status", status: "ready" });
  }

  /** Demandes du CLI vers le client : l'accord arrive à Floppy (au code), jamais au modèle. */
  private async onServerRequest(m: any): Promise<void> {
    const reply = (result: unknown): void => this.write({ jsonrpc: "2.0", id: m.id, result });
    try {
      switch (m.method) {
        case "item/fileChange/requestApproval": {
          const ch = this.changes.get(m.params?.itemId) ?? [];
          const bad = ch.find((c) => !isInside(this.o.pluginsDir, c.path, this.o.cwd));
          if (this.o.mode !== "plugin" || bad || !ch.length) {
            this.d.audit({ kind: "coder.permission", tool: "fileChange", allow: false, reason: bad ? `hors du dossier : ${bad.path}` : "refusé d'office" });
            return reply({ decision: "decline" });
          }
          const ok = await this.d.ask({
            tool: "fileChange", description: say(this.d.lang, `Modifier ${ch.map((c) => c.path).join(", ")}`, `Edit ${ch.map((c) => c.path).join(", ")}`), input: ch,
            diff: { path: ch[0]!.path, after: ch.map((c) => c.diff).join("\n") },
          });
          return reply({ decision: ok ? "accept" : "decline" });
        }
        case "item/commandExecution/requestApproval": {
          if (this.o.mode !== "plugin") return reply({ decision: "decline" });
          const cwd = String(m.params?.cwd ?? this.o.cwd);
          if (!isInside(this.o.pluginsDir, cwd)) {
            this.d.audit({ kind: "coder.permission", tool: "commandExecution", allow: false, reason: `hors du dossier : ${cwd}` });
            return reply({ decision: "decline" });
          }
          const ok = await this.d.ask({ tool: "commandExecution", description: say(this.d.lang, `Lancer la commande : ${short(m.params?.command ?? "", 200)}`, `Run the command: ${short(m.params?.command ?? "", 200)}`), input: { command: m.params?.command, cwd } });
          return reply({ decision: ok ? "accept" : "decline" });
        }
        case "mcpServer/elicitation/request":
          // Seul notre serveur est branché, et il est limité aux outils prévus.
          return reply(m.params?.serverName === "floppy" ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null });
        default:
          this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "refusé par Floppy" } });
      }
    } catch (e) {
      this.d.log("error", `codex : ${String(e)}`);
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "erreur" } });
    }
  }

  private onNotification(n: any): void {
    const pr = n.params ?? {};
    if (pr.threadId && this.threadId && pr.threadId !== this.threadId) return;
    switch (n.method) {
      case "item/agentMessage/delta":
        if (this.sawText && this.lastItemText !== pr.itemId) this.d.emit({ type: "text", delta: "\n\n" });
        this.lastItemText = pr.itemId; this.sawText = true;
        this.d.emit({ type: "text", delta: String(pr.delta ?? "") });
        break;
      case "item/started": {
        const it = pr.item ?? {};
        if (it.type === "mcpToolCall") this.d.emit({ type: "tool", id: it.id, name: String(it.tool), input: it.arguments, status: "running" });
        else if (it.type === "commandExecution") this.d.emit({ type: "tool", id: it.id, name: "commande", input: it.command, status: "running" });
        else if (it.type === "fileChange") {
          this.changes.set(it.id, (it.changes ?? []).map((c: any) => ({ path: String(c.path), diff: String(c.diff ?? "") })));
          this.d.emit({ type: "tool", id: it.id, name: "modification de fichiers", input: (it.changes ?? []).map((c: any) => c.path), status: "running" });
        }
        break;
      }
      case "item/completed": {
        const it = pr.item ?? {};
        if (it.type === "mcpToolCall") {
          const failed = it.status === "failed" || !!it.error;
          const out = it.error ? JSON.stringify(it.error) : JSON.stringify(it.result?.content ?? it.result ?? "");
          this.d.emit({ type: "tool", id: it.id, name: String(it.tool), status: failed ? "failed" : "done", output: short(out) });
        } else if (it.type === "commandExecution") {
          const failed = it.status === "failed" || it.status === "declined" || (it.exitCode ?? 0) !== 0;
          this.d.emit({ type: "tool", id: it.id, name: "commande", status: failed ? "failed" : "done", output: short(it.aggregatedOutput ?? "") });
        } else if (it.type === "fileChange") {
          const failed = it.status === "failed" || it.status === "declined";
          this.d.emit({ type: "tool", id: it.id, name: "modification de fichiers", status: failed ? "failed" : "done" });
        }
        break;
      }
      case "error":
        this.lastError = JSON.stringify(pr).slice(0, 400);
        break;
      case "turn/completed": {
        const t = pr.turn ?? {};
        if (t.status === "failed") this.finish("error", t.error?.message ?? this.lastError ?? "erreur");
        else if (t.status === "interrupted") this.finish("cancelled");
        else this.finish("end");
        break;
      }
    }
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.busy) { this.d.emit({ type: "done", stopReason: "error", error: say(this.d.lang, "Un message est déjà en cours.", "A message is already in progress.") }); return; }
    this.busy = true; this.sawText = false; this.lastError = "";
    this.d.emit({ type: "status", status: "busy" });
    this.ready.then(async (threadId) => {
      if (!this.busy) return;
      const r = await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
      this.turnId = r?.turn?.id;
    }).catch((e: Error) => this.finish("error", e.message));
  }

  cancel(): void {
    if (!this.busy) return;
    const turnId = this.turnId, threadId = this.threadId;
    this.finish("cancelled");
    this.turnId = undefined;
    if (!this.p) return;
    // Interruption propre ; si le CLI ne répond pas, on arrête le processus.
    if (threadId && turnId) {
      void this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    } else {
      // Tour pas encore parti : on repart d'un processus neuf.
      const p = this.p;
      this.p = undefined;
      void killTree(p);
      this.ready = this.boot();
      this.ready.catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.busy = false;
    const p = this.p;
    this.p = undefined;
    if (p) { p.stdin.end(); await killTree(p); }
  }
}
