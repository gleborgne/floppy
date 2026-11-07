// Un tour JSONL borné. Le contexte possède le processus ; une sortie incomplète n'est jamais un succès.
import { killTree, T, TextError, type Context } from "@floppy/core";
import type { BrainEvent } from "@floppy/contracts";
import { agentCommand } from "./command.ts";

export interface AgentCommand {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}
export interface WireEvent {
  text?: string;
  final?: string;
  tool?: { name: string; args: unknown };
  result?: { name: string; status: string };
  error?: string;
  complete?: boolean;
}

export async function* runAgentStream(ctx: Context, exe: string, command: AgentCommand, options: {
  signal?: AbortSignal; timeout_s: number;
  parse(event: any): WireEvent;
  /** Nom exposé par le CLI -> outil Floppy ; undefined = outil non autorisé. */
  tool(name: string): string | undefined;
  secrets?: string[];
}): AsyncIterable<BrainEvent> {
  options.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(options.timeout_s * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const launch = agentCommand(exe, command.args);
  const p = ctx.spawn(launch.command, launch.args, { cwd: command.cwd, env: command.env, windowsHide: true, stdio: "pipe" });
  const queue: (any | { closed: true; code: number | null } | { failure: Error })[] = [];
  let wake: (() => void) | undefined;
  const push = (event: any) => { queue.push(event); wake?.(); wake = undefined; };
  const redact = (value: string) => (options.secrets ?? []).reduce((s, key) => key ? s.split(key).join("[secret]") : s, value);
  const fail = (fr: string, en: string) => new TextError(T(fr, en));
  let buffer = "", bytes = 0, stderr = "";
  let full = "", final: string | undefined, completed = false;
  const abort = () => { push({ failure: fail(deadline.aborted ? "L'agent a dépassé le délai." : "Travail annulé.", deadline.aborted ? "The agent timed out." : "Task cancelled.") }); void killTree(p); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Une sortie de processus (ou sa fermeture par le noyau) réveille toujours le lecteur.
  p.on("error", () => push({ failure: fail("Le programme de l'agent n'a pas pu démarrer.", "The agent program could not start.") }));
  p.on("close", (code) => {
    if (buffer.trim()) {
      try { push(JSON.parse(buffer)); } catch { push({ failure: fail("Flux de l'agent invalide.", "Invalid agent stream.") }); }
    }
    push({ closed: true, code });
  });
  p.stderr?.on("data", (chunk) => { stderr = (stderr + redact(String(chunk))).slice(-2000); });
  p.stdout?.setEncoding("utf8");
  p.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    buffer += chunk;
    if (bytes > 16 * 1024 * 1024 || buffer.length > 1024 * 1024) {
      push({ failure: fail("La sortie de l'agent est trop volumineuse.", "The agent output is too large.") });
      void killTree(p); return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { push(JSON.parse(line)); } catch { push({ failure: fail("Flux de l'agent invalide.", "Invalid agent stream.") }); }
    }
  });
  p.stdin?.on("error", () => {});
  p.stdin?.end(command.stdin);
  try {
    for (;;) {
      if (!queue.length) await new Promise<void>((ok) => { wake = ok; });
      const event = queue.shift();
      if (event?.failure) throw event.failure;
      if (event?.closed) {
        if (event.code !== 0) throw fail(`L'agent a échoué : ${stderr || event.code}.`, `The agent failed: ${stderr || event.code}.`);
        if (!completed) throw fail("L'agent s'est arrêté sans résultat final.", "The agent stopped without a final result.");
        break;
      }
      const ev = options.parse(event);
      if (ev.error) throw fail(`Erreur de l'agent : ${redact(String(ev.error))}`, `Agent error: ${redact(String(ev.error))}`);
      if (ev.tool) {
        const name = options.tool(ev.tool.name);
        if (!name) {
          ctx.audit.write({ kind: "cli.unexpected_tools", tools: [ev.tool.name] });
          throw fail("L'agent a tenté d'utiliser un outil non autorisé.", "The agent attempted to use an unauthorized tool.");
        }
        yield { type: "tool", name, args: ev.tool.args };
      }
      if (ev.result) {
        const name = options.tool(ev.result.name);
        if (name) yield { type: "tool.result", name, status: ev.result.status };
      }
      if ((ev.text !== undefined && typeof ev.text !== "string") || (ev.final !== undefined && typeof ev.final !== "string")) {
        throw fail("Texte de l'agent invalide.", "Invalid agent text.");
      }
      if (ev.text) { full += ev.text; yield { type: "text", delta: ev.text }; }
      if (ev.final !== undefined) final = ev.final;
      if (ev.complete) completed = true;
    }
    if (!full && final) { full = final; yield { type: "text", delta: final }; }
    yield { type: "done", text: final ?? full };
  } finally {
    signal.removeEventListener("abort", abort);
    await killTree(p);
  }
}
