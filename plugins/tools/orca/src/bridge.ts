// Pont avec le plugin Orca « Floppy » (dossier ../orca-plugin) : Orca prévient Floppy dès qu'un agent change d'état.
// HTTP sur 127.0.0.1, port libre, jeton aléatoire. Port et jeton sont écrits dans <home>/orca-bridge.json
// (dossier de l'utilisateur, lisible par lui seul), où le plugin Orca les lit. Même principe que control.ts.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "@floppy/core";
import type { Kind } from "./speech.ts";

/** Le pont est « en direct » s'il a parlé depuis moins de 10 min (le plugin Orca dit bonjour en démarrant). */
export const BRIDGE_LIVE_MS = 10 * 60_000;
/** Pont en direct : une vérification par minute suffit (filet de sécurité). */
export const BRIDGE_POLL_MS = 60_000;
/** Un état reçu du pont gagne pendant 30 s sur la vérification, qui peut voir un état plus ancien. */
export const EVENT_WINS_MS = 30_000;
const MAX_BODY = 64 * 1024;

/** Message du plugin Orca. Vient d'un autre programme : chaque champ est vérifié avant usage. */
export interface BridgeEvent {
  kind?: unknown;
  workspaceId?: unknown;
  paneKey?: unknown;
  terminalId?: unknown;
  title?: unknown;
  state?: unknown;
  outcome?: unknown;
  mainAgent?: { state: string; outcome?: string; stateStartedAt?: number };
  receivedAt?: number;
  sentAt?: number;
  eventId?: string;
  bridgeId?: string;
  sequence?: number;
}

/** États d'un événement Orca : working, blocked, waiting, done (+ outcome du agent principal). */
export function kindOfEvent(state: unknown, outcome: unknown): Kind {
  const s = String(state ?? "").toLowerCase();
  if (s === "working") return "running";
  if (s === "blocked" || s === "waiting") return "waiting";
  if (outcome === "interruption" || outcome === "cancellation") return "interrupted";
  if (s === "done" && outcome === "success") return "finished";
  // Compatibilité du Kind : aucune panne ni fin non confirmée ne devient un succès.
  return "interrupted";
}

export interface BridgeDiagnostic {
  reason: string; at: number; eventId?: string; bridgeId?: string; receivedAt?: number;
  sentAt?: number; sourceLatencyMs?: number; queueLength: number;
}
export interface BridgeOptions {
  now?: () => number;
  diagnostic?: (data: BridgeDiagnostic) => void;
  requestTimeoutMs?: number;
  maxAgeMs?: number;
}
const states = new Set(["working", "blocked", "waiting", "done"]);
const object = (e: unknown): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e);
const text = (e: unknown, max: number, nonempty = true): e is string => typeof e === "string" && (!nonempty || !!e.length) && e.length <= max && !/[\u0000-\u001f]/u.test(e);
const time = (e: unknown): e is number => typeof e === "number" && Number.isFinite(e) && e >= 0;

/** Les anciens hello/agent restent acceptés ; les enveloppes nouvelles sont complètes. */
export function validBridgeEvent(e: unknown): e is BridgeEvent {
  if (!object(e) || typeof e.kind !== "string" || !["hello", "heartbeat", "agent"].includes(e.kind)) return false;
  const versioned = ["eventId", "bridgeId", "sequence", "sentAt"].some((k) => e[k] !== undefined);
  if (versioned && (!text(e.eventId, 160) || !text(e.bridgeId, 128) || !Number.isSafeInteger(e.sequence) || (e.sequence as number) < 1 || !time(e.sentAt))) return false;
  if (e.kind !== "agent") return !["workspaceId", "paneKey", "terminalId", "title", "state", "outcome", "mainAgent", "receivedAt"].some((k) => e[k] !== undefined);
  if (!(e.workspaceId === null || text(e.workspaceId, 2048)) || !text(e.paneKey, 2048) || typeof e.state !== "string" || !states.has(e.state)) return false;
  if (e.terminalId !== undefined && !text(e.terminalId, 2048)) return false;
  if (e.title !== undefined && !text(e.title, 4096, false)) return false;
  if (e.outcome !== undefined && !text(e.outcome, 128)) return false;
  if (e.receivedAt !== undefined && (!time(e.receivedAt) || e.receivedAt <= 0)) return false;
  if (versioned && !time(e.receivedAt)) return false;
  if (e.mainAgent !== undefined) {
    if (!object(e.mainAgent) || typeof e.mainAgent.state !== "string" || !states.has(e.mainAgent.state)) return false;
    if (e.mainAgent.outcome !== undefined && !text(e.mainAgent.outcome, 128)) return false;
    // Horloge du serveur de l'agent, éventuellement distant : garder sa valeur brute finie.
    if (e.mainAgent.stateStartedAt !== undefined && (typeof e.mainAgent.stateStartedAt !== "number" || !Number.isFinite(e.mainAgent.stateStartedAt))) return false;
    if (e.outcome !== undefined && e.mainAgent.outcome !== undefined && e.outcome !== e.mainAgent.outcome) return false;
  }
  return true;
}

/** Ouvre la porte locale ; acquitte seulement après validation et acceptation. */
export async function startBridge(
  home: string,
  onEvent: (e: BridgeEvent) => void | Promise<void>,
  warn: (msg: string, data?: Record<string, unknown>) => void,
  options: BridgeOptions = {},
): Promise<() => Promise<void>> {
  const now = options.now ?? Date.now;
  const maxAge = Math.max(1, Math.min(300_000, options.maxAgeMs ?? 120_000));
  const timeout = Math.max(10, Math.min(10_000, options.requestTimeoutMs ?? 2500));
  const token = randomBytes(24).toString("hex");
  const serverId = randomBytes(16).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const file = join(home, "orca-bridge.json");
  const seen = new Map<string, number>();
  const accepting = new Set<string>();
  const callbackTimers = new Set<ReturnType<typeof setTimeout>>();
  const latest = new Map<string, { at: number; sequence?: number; bridgeId?: string }>();
  let pending = 0, stopped = false;
  let serial: Promise<void> = Promise.resolve();
  const report = (reason: string, e?: BridgeEvent) => {
    try { options.diagnostic?.({ reason, at: now(), eventId: e?.eventId, bridgeId: e?.bridgeId,
      receivedAt: e?.receivedAt, sentAt: e?.sentAt,
      sourceLatencyMs: e?.receivedAt === undefined ? undefined : now() - e.receivedAt, queueLength: pending }); } catch { /* observabilité seulement */ }
  };
  const server = createServer((req, res) => {
    const reply = (status: number): void => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status); res.end(); } };
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(401);
    if (req.method !== "POST" || req.url !== "/orca") return reply(404);
    if (pending >= 32 || stopped) { report("request_capacity"); return reply(503); }
    pending++;
    let size = 0, ended = false;
    const parts: Buffer[] = [];
    const timer = setTimeout(() => { report("request_timeout"); reply(408); req.destroy(); }, timeout);
    res.once("close", () => { clearTimeout(timer); pending--; });
    req.on("error", () => { clearTimeout(timer); });
    req.on("data", (chunk: Buffer) => {
      if (ended) return;
      size += chunk.length;
      if (size > MAX_BODY) { ended = true; report("request_oversize"); reply(413); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on("end", () => {
      if (ended) return;
      ended = true;
      let e: unknown;
      try { e = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { report("invalid_json"); return reply(400); }
      if (!validBridgeEvent(e)) { report("invalid_schema"); return reply(400); }
      const event: BridgeEvent = {};
      for (const key of ["kind", "workspaceId", "paneKey", "terminalId", "title", "state", "outcome", "receivedAt", "sentAt", "eventId", "bridgeId", "sequence"] as const) {
        if (e[key] !== undefined) Object.assign(event, { [key]: e[key] });
      }
      if (e.mainAgent) event.mainAgent = { state: e.mainAgent.state, outcome: e.mainAgent.outcome, stateStartedAt: e.mainAgent.stateStartedAt };
      // Une seule admission à la fois : deux requêtes du même id n'exécutent jamais deux callbacks.
      serial = serial.then(async () => {
        if (stopped || res.destroyed || res.writableEnded) return;
        clearTimeout(timer);
        for (const [id, at] of seen) if (now() - at >= maxAge) seen.delete(id);
        for (const [id, value] of latest) if (now() - value.at >= maxAge) latest.delete(id);
        const stamp = event.receivedAt ?? event.sentAt;
        if (stamp !== undefined && (now() - stamp >= maxAge || stamp - now() > 30_000)) {
          report("drop_expired", event); return reply(204);
        }
        const eventKey = event.eventId && JSON.stringify([event.bridgeId, event.eventId]);
        const reservationKey = eventKey || JSON.stringify([event.kind, event.workspaceId, event.paneKey, event.state, event.outcome, event.receivedAt]);
        if (eventKey && seen.has(eventKey)) { report("dedupe_event", event); return reply(204); }
        if (accepting.has(reservationKey)) { report("acceptance_pending", event); return reply(503); }
        if (accepting.size >= 32) { report("acceptance_capacity", event); return reply(503); }
        const agentKey = event.kind === "agent" ? JSON.stringify([event.workspaceId, event.paneKey]) : undefined;
        const prev = agentKey ? latest.get(agentKey) : undefined;
        if (prev && (stamp !== undefined && stamp < prev.at ||
          event.bridgeId === prev.bridgeId && event.sequence !== undefined && prev.sequence !== undefined && event.sequence <= prev.sequence)) {
          report("drop_stale", event); return reply(204);
        }
        let timerCallback: ReturnType<typeof setTimeout> | undefined;
        try {
          accepting.add(reservationKey);
          const acceptance = Promise.resolve().then(() => onEvent(event)).then(() => {
            if (stopped) return;
            if (eventKey) { seen.set(eventKey, now()); if (seen.size > 2048) seen.delete(seen.keys().next().value!); }
            // Un callback lent ne remplace jamais une admission plus récente.
            const current = agentKey ? latest.get(agentKey) : undefined;
            if (agentKey && (!current || (stamp ?? now()) >= current.at)) {
              latest.delete(agentKey); latest.set(agentKey, { at: stamp ?? now(), sequence: event.sequence, bridgeId: event.bridgeId });
              if (latest.size > 1000) latest.delete(latest.keys().next().value!);
            }
          }).finally(() => { accepting.delete(reservationKey); });
          // onEvent doit accepter vite ; ne jamais y attendre une lecture réseau. Un timeout ne peut pas annuler ses effets.
          await Promise.race([
            acceptance,
            new Promise<never>((_, reject) => {
              timerCallback = setTimeout(() => reject(new Error("timeout")), timeout);
              callbackTimers.add(timerCallback);
            }),
          ]);
          report("accepted", event); reply(204);
        } catch { report("acceptance_failed", event); reply(503); }
        finally { clearTimeout(timerCallback); if (timerCallback) callbackTimers.delete(timerCallback); }
      }).catch(() => { report("acceptance_failed", event); reply(503); });
    });
  });
  server.requestTimeout = timeout;
  server.headersTimeout = timeout;
  server.maxConnections = 32;
  try {
    await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(0, "127.0.0.1", ok); });
    const port = (server.address() as { port: number }).port;
    writeJsonAtomic(file, { port, token, pid: process.pid, bridgeId: serverId }, { mode: 0o600 });
  } catch {
    server.closeAllConnections(); server.close();
    warn("Pont Orca : impossible d'ouvrir le port local, on garde la vérification régulière.");
    return async () => {};
  }
  return async () => {
    if (stopped) return;
    stopped = true;
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeAllConnections();
    for (const timer of callbackTimers) clearTimeout(timer);
    callbackTimers.clear(); accepting.clear();
    await closed;
    seen.clear(); latest.clear(); report("shutdown");
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as { bridgeId?: string };
      if (cur.bridgeId === serverId) rmSync(file);
    } catch { /* déjà retiré */ }
  };
}
