// Agent Claude Code : un processus par conversation (stream-json en entrée et en sortie), gardé pour plusieurs tours.
// Après un arrêt (stop), le tour suivant relance un processus avec --resume <session_id>.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree } from "@floppy/core";
import type { CoderMode } from "@floppy/contracts";
import { cleanEnv, say, short, signInMessage, SIGN_IN_RE, type Runner, type RunnerDeps } from "./common.ts";

export const PLUGIN_BUILTIN = ["Read", "Edit", "Write", "Glob", "Grep"];
export const PERMISSION_TOOL = "mcp__floppy__permission";
/** Recherche web de Claude Code (mode réglages, si le réglage assistant_web est actif). Lecture seule. */
export const WEB_TOOLS = ["WebSearch", "WebFetch"];

export interface ClaudeOptions {
  exe: string;
  /** Arguments avant les nôtres (tests : le script du faux CLI). */
  exeArgs?: string[];
  mode: CoderMode;
  cwd: string;
  system: string;
  model: () => string;
  mcpUrl: string;
  mcpToken: string;
  /** Outils MCP Floppy autorisés (noms sans préfixe). */
  mcpTools: string[];
  /** Mode réglages : recherche web permise (WebSearch, WebFetch). */
  web?: boolean;
}

export function claudeArgs(o: ClaudeOptions, resume?: string): string[] {
  const plugin = o.mode === "plugin";
  const mcpConfig = JSON.stringify({ mcpServers: { floppy: { type: "http", url: o.mcpUrl, headers: { Authorization: "Bearer ${FLOPPY_MCP_TOKEN}" } } } });
  const mcp = o.mcpTools.map((t) => `mcp__floppy__${t}`);
  const web = !plugin && o.web === true ? WEB_TOOLS : [];
  // Mode plugin : Read/Glob/Grep ne sont PAS pré-autorisés, sinon Claude n'appelle pas l'outil de permission
  // (qui garde le dossier des plugins). Les lectures dans ce dossier y sont acceptées sans question.
  const allowed = plugin ? [...mcp] : [...web, ...mcp];
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", o.model(),
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--setting-sources", "project", "--disable-slash-commands",
    "--tools", plugin ? PLUGIN_BUILTIN.join(",") : web.join(","),
    "--allowedTools", allowed.join(","),
    ...(plugin ? ["--permission-prompt-tool", PERMISSION_TOOL] : ["--permission-mode", "dontAsk"]),
    "--system-prompt", o.system,
    ...(resume ? ["--resume", resume] : []),
  ];
}

interface Proc { p: ChildProcessWithoutNullStreams; stderr: string }

export class ClaudeRunner implements Runner {
  private o: ClaudeOptions;
  private d: RunnerDeps;
  private proc?: Proc;
  private claudeSession?: string;
  private busy = false;
  private closed = false;
  private sawText = false;
  private lastWasText = false;
  private errors: string[] = [];
  private tools = new Map<string, string>();

  constructor(o: ClaudeOptions, d: RunnerDeps) {
    this.o = o; this.d = d;
    this.d.emit({ type: "status", status: "starting" });
    this.spawnProc();
    this.d.emit({ type: "status", status: "ready" });
  }

  private spawnProc(): Proc {
    const args = claudeArgs(this.o, this.claudeSession);
    const p = this.d.spawn(this.o.exe, [...(this.o.exeArgs ?? []), ...args], {
      cwd: this.o.cwd, windowsHide: true,
      env: cleanEnv({ FLOPPY_MCP_TOKEN: this.o.mcpToken, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1" }),
    }) as ChildProcessWithoutNullStreams;
    const proc: Proc = { p, stderr: "" };
    this.proc = proc;
    p.stdin.on("error", () => {});
    p.stderr.on("data", (b) => { proc.stderr = (proc.stderr + String(b)).slice(-2000); this.d.log("debug", `claude : ${String(b).slice(0, 300)}`); });
    p.on("error", (e) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.fail(say(this.d.lang, `Impossible de lancer Claude : ${e.message}`, `Cannot start Claude: ${e.message}`), proc);
    });
    createInterface({ input: p.stdout }).on("line", (l) => {
      if (this.proc !== proc) return;
      let ev: any;
      try { ev = JSON.parse(l); } catch { return; }
      this.onEvent(ev, proc);
    });
    p.on("exit", () => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.fail(proc.stderr.trim().split("\n").pop() || say(this.d.lang, "Le processus Claude s'est arrêté.", "The Claude process stopped."), proc);
    });
    return proc;
  }

  /** Fin d'un tour en erreur. */
  private fail(text: string, proc: Proc): void {
    if (!this.busy) return;
    this.busy = false;
    const signIn = SIGN_IN_RE.test(`${text} ${proc.stderr} ${this.errors.join(" ")}`);
    this.d.emit({ type: "done", stopReason: "error", error: signIn ? signInMessage("claude", this.d.lang) : text, ...(signIn ? { signIn: true } : {}) });
  }

  private onEvent(ev: any, proc: Proc): void {
    if (ev.type === "system" && ev.subtype === "init") {
      if (typeof ev.session_id === "string") this.claudeSession = ev.session_id;
      // Contrôle de sécurité : un outil intégré non prévu coupe tout.
      const ok = new Set(this.o.mode === "plugin" ? PLUGIN_BUILTIN : this.o.web ? WEB_TOOLS : []);
      const extra = ((ev.tools ?? []) as string[]).filter((t) => !ok.has(t) && !t.startsWith("mcp__floppy__"));
      if (extra.length) {
        this.d.audit({ kind: "coder.unexpected_tools", cli: "claude", tools: extra });
        void killTree(proc.p);
        this.proc = undefined;
        this.fail(say(this.d.lang, `Claude expose des outils non prévus : ${extra.join(", ")}`, `Claude exposes unexpected tools: ${extra.join(", ")}`), proc);
      }
    } else if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "content_block_start" && e.content_block?.type === "text") {
        if (this.sawText && !this.lastWasText) this.d.emit({ type: "text", delta: "\n\n" });
        this.lastWasText = true;
      } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
        this.sawText = true; this.lastWasText = true;
        this.d.emit({ type: "text", delta: e.delta.text });
      } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
        this.lastWasText = false;
      }
    } else if (ev.type === "assistant") {
      if (ev.error) this.errors.push(String(ev.error));
      for (const c of ev.message?.content ?? []) {
        if (c.type === "tool_use") {
          const name = String(c.name).replace(/^mcp__floppy__/, "");
          this.tools.set(c.id, name);
          this.d.emit({ type: "tool", id: c.id, name, input: c.input, status: "running" });
        } else if (c.type === "text" && typeof c.text === "string" && /not logged in|\/login/i.test(c.text)) {
          this.errors.push(c.text);
        }
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const out = typeof c.content === "string" ? c.content
          : Array.isArray(c.content) ? c.content.map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n") : "";
        this.d.emit({ type: "tool", id: c.tool_use_id, name: this.tools.get(c.tool_use_id) ?? "outil", status: c.is_error ? "failed" : "done", output: short(out) });
      }
    } else if (ev.type === "result") {
      if (!this.busy) return;
      this.busy = false;
      this.d.emit({ type: "status", status: "ready" });
      if (ev.is_error) {
        const text = String(ev.result ?? ev.subtype ?? "erreur");
        const signIn = SIGN_IN_RE.test(`${text} ${this.errors.join(" ")}`);
        this.d.emit({ type: "done", stopReason: "error", error: signIn ? signInMessage("claude", this.d.lang) : text, ...(signIn ? { signIn: true } : {}) });
      } else {
        this.d.emit({ type: "done", stopReason: "end" });
      }
    }
  }

  send(text: string): void {
    if (this.closed) return;
    if (this.busy) { this.d.emit({ type: "done", stopReason: "error", error: say(this.d.lang, "Un message est déjà en cours.", "A message is already in progress.") }); return; }
    const proc = this.proc ?? this.spawnProc();
    this.busy = true; this.sawText = false; this.lastWasText = false; this.errors = [];
    this.d.emit({ type: "status", status: "busy" });
    proc.p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  }

  cancel(): void {
    const proc = this.proc;
    if (!this.busy || !proc) return;
    this.busy = false;
    this.proc = undefined; // le tour suivant relance un processus (--resume)
    void killTree(proc.p);
    this.d.emit({ type: "done", stopReason: "cancelled" });
    this.d.emit({ type: "status", status: "ready" });
  }

  async close(): Promise<void> {
    this.closed = true; this.busy = false;
    const proc = this.proc;
    this.proc = undefined;
    if (proc) { proc.p.stdin.end(); await killTree(proc.p); }
  }
}
