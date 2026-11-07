// Hermes : propriétaire du gateway privé, jamais un client susceptible de démarrer un daemon détaché.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import WebSocket from "ws";
import { killTree, T, TextError, type Context } from "@floppy/core";
import type { BrainEvent } from "@floppy/contracts";
import type { AgentCommand } from "./stream.ts";
import { agentCommand } from "./command.ts";

export async function* runHermes(ctx: Context, exe: string, command: AgentCommand, opts: {
  exeArgs: string[]; model: string; provider: string; timeout_s: number; signal?: AbortSignal;
  tool(name: string): string | undefined;
}): AsyncIterable<BrainEvent> {
  const stopped = new AbortController();
  const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(opts.timeout_s * 1000), ...(opts.signal ? [opts.signal] : [])]);
  signal.throwIfAborted();
  const launch = agentCommand(exe, [...opts.exeArgs, "gateway", "run", "--no-supervise", "--external-supervisor"]);
  const owner = ctx.spawn(launch.command, launch.args,
    { cwd: command.cwd, env: command.env, windowsHide: true, stdio: "ignore" });
  let socket: WebSocket | undefined;
  let ended = false;
  const fail = (fr: string, en: string) => new TextError(T(fr, en));
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const events: any[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    for (const p of pending.values()) p.reject(error);
    pending.clear(); wake?.(); wake = undefined;
  };
  owner.on("error", () => stop(fail("Hermes n'a pas pu démarrer.", "Hermes could not start.")));
  owner.on("exit", () => { if (!ended) stop(fail("Le gateway Hermes s'est arrêté.", "The Hermes gateway stopped.")); });
  const abort = () => { stop(fail("Travail Hermes interrompu ou délai dépassé.", "Hermes task interrupted or timed out.")); socket?.terminate(); void killTree(owner); };
  signal.addEventListener("abort", abort, { once: true });
  const dispose = ctx.effect(async () => { stopped.abort(); socket?.terminate(); await killTree(owner); });
  let nextId = 1;
  const request = (method: string, params: object): Promise<any> => {
    signal.throwIfAborted(); if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (err) => {
        if (err) { pending.delete(id); reject(fail("Connexion Hermes perdue.", "Hermes connection lost.")); }
      });
    });
  };
  try {
    const startup = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let ticket: any;
    while (!ticket) {
      startup.throwIfAborted(); if (failure) throw failure;
      const attach = agentCommand(exe, [...opts.exeArgs, "gateway", "attach", "--json", "--timeout", "2"]);
      const result = await ctx.exec(attach.command, attach.args,
        { cwd: command.cwd, env: command.env, timeoutMs: 4000, signal: startup, allowFailure: true, maxBuffer: 65536 });
      if (result.code === 0) {
        try { ticket = JSON.parse(result.stdout); } catch { throw fail("Réponse de démarrage Hermes invalide.", "Invalid Hermes startup response."); }
      } else {
        await new Promise<void>((ok, reject) => {
          const cancel = () => reject(fail("Démarrage Hermes interrompu.", "Hermes startup interrupted."));
          startup.addEventListener("abort", cancel, { once: true });
          ctx.timeout(() => { startup.removeEventListener("abort", cancel); ok(); }, 150);
        });
      }
    }
    const url = new URL(ticket.url);
    if (ticket.state !== "ready" || !["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || resolve(ticket.endpoint?.control_home ?? "") !== resolve(command.env.HERMES_HOME!)
      || !Array.isArray(ticket.protocols) || !ticket.protocols.includes("hermes-gateway-v1")) {
      throw fail("Le gateway Hermes découvert ne correspond pas au profil privé.", "The discovered Hermes gateway does not match the private profile.");
    }
    socket = new WebSocket(url, ticket.protocols, { maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
    socket.on("message", (data) => {
      let ev: any;
      try { ev = JSON.parse(String(data)); } catch { stop(fail("Flux Hermes invalide.", "Invalid Hermes stream.")); return; }
      if (ev.id !== undefined) {
        const p = pending.get(ev.id); if (!p) return; pending.delete(ev.id);
        // Les erreurs brutes peuvent contenir le ticket : elles restent hors du journal et de l'interface.
        if (ev.error) p.reject(fail("Hermes a refusé la demande.", "Hermes rejected the request.")); else p.resolve(ev.result);
      } else if (ev.params) {
        if (events.length >= 1000) { stop(fail("Trop d'événements Hermes en attente.", "Too many pending Hermes events.")); return; }
        events.push(ev.params); wake?.(); wake = undefined;
      }
    });
    socket.on("error", () => stop(fail("Connexion Hermes perdue.", "Hermes connection lost.")));
    socket.on("close", () => { if (!ended) stop(fail("Hermes s'est déconnecté sans résultat.", "Hermes disconnected without a result.")); });
    await new Promise<void>((ok, reject) => {
      socket!.once("open", () => socket!.protocol === "hermes-gateway-v1" ? ok() : reject(fail("Protocole Hermes incompatible.", "Incompatible Hermes protocol.")));
      socket!.once("error", () => reject(fail("Connexion Hermes impossible.", "Could not connect to Hermes.")));
      socket!.once("close", () => reject(fail("Connexion Hermes fermée.", "Hermes connection closed.")));
    });
    if (failure) throw failure;
    const description = await request("runtime.describe", {});
    const create = description.session_create;
    const params = ["cwd", "model", "provider", "toolsets", "ignore_rules", "max_turns"];
    if (!create || !Array.isArray(create.sources) || !create.sources.includes("oneshot")
      || !params.every((p) => Array.isArray(create.parameters) ? create.parameters.includes(p) : Object.hasOwn(create.parameters ?? {}, p))) {
      throw fail("Cette version d'Hermes ne permet pas de contrôler la session.", "This Hermes version does not support controlled sessions.");
    }
    const session = await request("session.create", { request_id: randomUUID(), source: "oneshot", cwd: command.cwd,
      model: opts.model, ...(opts.provider ? { provider: opts.provider } : {}), toolsets: ["floppy"], ignore_rules: true, max_turns: 30 });
    const sid = session.session_id ?? session.stored_session_id;
    if (typeof sid !== "string") throw fail("Session Hermes invalide.", "Invalid Hermes session.");
    const receipt = await request("prompt.submit", { session_id: sid, input_id: randomUUID(), text: command.stdin, finite: true });
    if (!receipt.admission_id) throw fail("Hermes n'a pas accepté la mission.", "Hermes did not accept the task.");
    let full = "";
    while (!ended) {
      signal.throwIfAborted(); if (failure) throw failure;
      if (!events.length) await new Promise<void>((ok) => { wake = ok; });
      if (failure) throw failure;
      const ev = events.shift(); if (!ev || ev.session_id !== sid) continue;
      if (ev.type === "session.replay_gap") throw fail("Une partie du résultat Hermes a été perdue.", "Part of the Hermes result was lost.");
      if (["approval.request", "clarify.request"].includes(ev.type)) throw fail("Hermes a demandé une interaction hors du circuit Floppy.", "Hermes requested an interaction outside Floppy.");
      if (ev.admission_id !== receipt.admission_id) continue;
      const payload = ev.payload ?? {};
      if (ev.type === "message.delta") {
        const text = payload.text ?? payload.delta ?? payload.content;
        if (typeof text === "string") { full += text; yield { type: "text", delta: text }; }
      } else if (ev.type === "tool.start" || ev.type === "tool.complete") {
        const name = opts.tool(payload.tool_name);
        if (!name) throw fail("Hermes a tenté d'utiliser un outil non autorisé.", "Hermes attempted to use an unauthorized tool.");
        if (ev.type === "tool.start") yield { type: "tool", name, args: payload.args ?? {} };
        else yield { type: "tool.result", name, status: payload.is_error ? "failed" : "done" };
      } else if (ev.type === "message.complete") {
        if (payload.outcome !== "completed" || payload.status !== "complete") throw fail("La mission Hermes a échoué.", "The Hermes task failed.");
        const final = (typeof payload.text === "string" && payload.text) || (typeof payload.content === "string" && payload.content) || full;
        if (!full && final) yield { type: "text", delta: final };
        ended = true;
        yield { type: "done", text: final };
      }
      if (full.length > 200000) throw fail("Le résultat Hermes est trop volumineux.", "The Hermes result is too large.");
    }
  } finally {
    ended = true;
    signal.removeEventListener("abort", abort);
    await dispose();
  }
}
