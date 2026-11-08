// Plugin Orca « Floppy » : prévient Floppy dès qu'un agent change d'état (au lieu d'attendre la vérification suivante).
// Tourne dans Orca (worker Node). Lit le port et le jeton dans <dossier de Floppy>/orca-bridge.json, écrit par
// le plugin `orca` de Floppy, puis envoie l'événement en HTTP sur 127.0.0.1. Floppy éteint : rien ne se passe.
// Aucune dépendance au dépôt Floppy : ce dossier se charge tel quel dans Orca (Orca transpile le TypeScript).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Ce dont le worker a besoin de l'API Orca (sous-ensemble de `orca/worker`). */
export interface OrcaApi {
  log(line: string): void;
  events: { on(event: "agent.status.changed", handler: (e: AgentEvent) => unknown): unknown };
}
export interface AgentEvent {
  workspaceId: string | null;
  paneKey: string;
  terminalId?: string;
  title?: string;
  state: string;
  receivedAt?: number;
  mainAgent?: { state: string; outcome?: string; stateStartedAt?: number };
}
export interface BridgeInfo { port: number; token: string; bridgeId?: string }

/**
 * Où chercher le fichier du pont, dans l'ordre. Même dossier que floppyHome() côté Floppy : FLOPPY_HOME, sinon
 * LOCALAPPDATA/floppy, sinon ~/.local/share/floppy. Orca lance ses workers sans LOCALAPPDATA : sous Windows, on
 * ajoute donc ~/AppData/Local/floppy (sa valeur par défaut).
 */
export function bridgeFiles(
  env: Record<string, string | undefined> = process.env, home: string = homedir(), platform: string = process.platform,
  chosen: (base: string) => string | undefined = readChosenHome,
): string[] {
  const defaults = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "floppy"),
    platform === "win32" ? join(home, "AppData", "Local", "floppy") : undefined,
    join(home, ".local", "share", "floppy"),
  ].filter((b): b is string => !!b);
  // Répertoire de travail choisi par l'utilisateur : noté dans <dossier par défaut>/home.json.
  const picked = defaults.map((b) => chosen(b)).filter((b): b is string => !!b);
  const bases = [env.FLOPPY_HOME, ...picked, ...defaults].filter((b): b is string => !!b);
  return [...new Set(bases)].map((b) => join(b, "orca-bridge.json"));
}

function readChosenHome(base: string): string | undefined {
  try {
    const h = (JSON.parse(readFileSync(join(base, "home.json"), "utf8")) as { home?: unknown }).home;
    return typeof h === "string" && h ? h : undefined;
  } catch { return undefined; }
}

/** Premier fichier du pont lisible, ou la liste des essais ratés. */
export function readBridgeInfo(files: string[] = bridgeFiles(), read: (f: string) => string = (f) => readFileSync(f, "utf8")): BridgeInfo | string {
  const tried: string[] = [];
  for (const f of files) {
    try {
      const info = JSON.parse(read(f)) as BridgeInfo;
      if (!Number.isInteger(info?.port) || info.port < 1 || info.port > 65535 || typeof info.token !== "string" || !info.token || info.token.length > 256) throw new Error("fichier invalide");
      return info;
    } catch { tried.push(`${f} : absent`); }
  }
  return tried.join(" ; ");
}

export interface BridgeDeps {
  readInfo?: () => BridgeInfo | undefined;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  now?: () => number;
  diagnostic?: (data: WorkerDiagnostic) => void;
  maxQueue?: number;
  maxAgeMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  bridgeId?: string;
}

export interface WorkerDiagnostic {
  reason: string; at: number; bridgeId: string; eventId?: string;
  receivedAt?: number; sentAt?: number; sourceLatencyMs?: number; queueLength: number; attempt?: number;
}

/** Transport borné ; les erreurs ne contiennent jamais le jeton ni le contenu. */
export function createBridge(deps: BridgeDeps = {}) {
  const readInfo = deps.readInfo ?? (() => { const r = readBridgeInfo(); return typeof r === "string" ? undefined : r; });
  const fetchImpl = deps.fetchImpl ?? fetch;
  let info: BridgeInfo | undefined;
  let down = false;
  let controller: AbortController | undefined;
  let stopped = false;
  const post = async (i: BridgeInfo, msg: unknown): Promise<boolean> => {
    controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetchImpl(`http://127.0.0.1:${i.port}/orca`, {
          method: "POST", headers: { Authorization: `Bearer ${i.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(msg), signal: controller.signal,
        }).then((r) => { void r.body?.cancel().catch(() => {}); return r.ok; }),
        new Promise<boolean>((resolve) => {
          const active = controller!;
          active.signal.addEventListener("abort", () => resolve(false), { once: true });
          timer = setTimeout(() => active.abort(), deps.requestTimeoutMs ?? 2000);
        }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); controller = undefined; }
  };
  const send = async (msg: unknown): Promise<boolean> => {
    if (stopped) return false;
    let ok = !!info && await post(info, msg);
    if (!ok && !stopped) {
      try { info = readInfo(); } catch { info = undefined; }
      ok = !!info && await post(info, msg);
    }
    if (!stopped && ok !== !down) {
      down = !ok;
      try { deps.log?.(ok ? "Floppy joint." : "Floppy ne répond pas (pas lancé ?)."); } catch { /* journal facultatif */ }
    }
    return ok;
  };
  return Object.assign(send, { stop: () => { stopped = true; controller?.abort(); } });
}

/** Le début du tour fait partie de l'identité ; deux tours identiques restent distincts. */
export function changes() {
  const last = new Map<string, string>();
  return (e: AgentEvent): boolean => {
    const key = JSON.stringify([e.workspaceId, e.paneKey]);
    const s = JSON.stringify([e.state, e.mainAgent?.state, e.mainAgent?.outcome, e.mainAgent?.stateStartedAt]);
    if (last.get(key) === s) return false;
    last.delete(key); last.set(key, s);
    if (last.size > 500) last.delete(last.keys().next().value!);
    return true;
  };
}

/** File FIFO en mémoire uniquement : aucun historique hors ligne après la fin du worker. */
export function createDeliveryQueue(deps: BridgeDeps = {}) {
  const now = deps.now ?? Date.now;
  const bridgeId = deps.bridgeId ?? randomUUID();
  const send = createBridge(deps);
  type Entry = { msg: Record<string, unknown>; identity?: string; attempts: number; queuedAt: number; resolve: (ok: boolean) => void };
  const queue: Entry[] = [];
  const seen = new Map<string, { at: number; eventId: string; receivedAt?: number; sentAt: number }>();
  let sequence = 0, stopped = false, running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const maxQueue = Math.max(1, Math.min(1000, deps.maxQueue ?? 128));
  const maxAge = Math.max(1, Math.min(300_000, deps.maxAgeMs ?? 120_000));
  const maxAttempts = Math.max(1, Math.min(20, deps.maxAttempts ?? 6));
  const report = (reason: string, entry?: Entry, prior?: { eventId: string; receivedAt?: number; sentAt: number }) => {
    const m = entry?.msg;
    const data: WorkerDiagnostic = {
      reason, at: now(), bridgeId, eventId: prior?.eventId ?? m?.eventId as string | undefined,
      receivedAt: prior?.receivedAt ?? m?.receivedAt as number | undefined, sentAt: prior?.sentAt ?? m?.sentAt as number | undefined,
      sourceLatencyMs: typeof (prior?.receivedAt ?? m?.receivedAt) === "number" ? now() - Number(prior?.receivedAt ?? m?.receivedAt) : undefined,
      queueLength: queue.length, attempt: entry?.attempts,
    };
    try { deps.diagnostic?.(data); deps.log?.(`Pont Floppy : ${JSON.stringify(data)}`); } catch { /* diagnostic sans effet sur la livraison */ }
  };
  const remove = (entry: Entry, reason: string) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (entry.identity) seen.delete(entry.identity);
    report(reason, entry); entry.resolve(false);
  };
  const flush = async (): Promise<void> => {
    if (running || stopped) return;
    clearTimeout(timer); timer = undefined; running = true;
    try {
      while (queue.length && !stopped) {
        const entry = queue[0]!;
        if (now() - entry.queuedAt >= maxAge || (typeof entry.msg.receivedAt === "number" && now() - entry.msg.receivedAt >= maxAge)) {
          remove(entry, "drop_expired"); continue;
        }
        entry.attempts++;
        report("delivery_attempt", entry);
        const ok = await send(entry.msg);
        if (stopped) break;
        if (ok) {
          if (queue[0] === entry) queue.shift();
          report(entry.attempts > 1 ? "delivery_recovered" : "delivered", entry); entry.resolve(true);
        } else {
          report("delivery_failed", entry);
          if (entry.attempts >= maxAttempts) { remove(entry, "drop_attempts"); continue; }
          const delay = Math.min(15_000, (deps.backoffMs ?? 500) * 2 ** (entry.attempts - 1), Math.max(1, maxAge - (now() - entry.queuedAt)));
          report("retry_scheduled", entry);
          timer = setTimeout(() => { timer = undefined; void flush(); }, delay); timer.unref?.();
          break;
        }
      }
    } finally { running = false; }
  };
  const enqueue = (payload: Record<string, unknown>): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    // Identité source conservée après acquittement pendant la courte fenêtre de rétention.
    const identity = payload.kind === "agent" ? JSON.stringify([payload.workspaceId, payload.paneKey, payload.state, payload.outcome,
      (payload.mainAgent as AgentEvent["mainAgent"])?.state, (payload.mainAgent as AgentEvent["mainAgent"])?.outcome, (payload.mainAgent as AgentEvent["mainAgent"])?.stateStartedAt,
      (payload.mainAgent as AgentEvent["mainAgent"])?.stateStartedAt === undefined ? payload.receivedAt : undefined]) : undefined;
    for (const [key, value] of seen) if (now() - value.at >= maxAge) seen.delete(key);
    if (identity && seen.has(identity)) { report("dedupe_source", undefined, seen.get(identity)); return Promise.resolve(false); }
    const msg = { ...payload, bridgeId, eventId: `${bridgeId}:${++sequence}`, sequence, sentAt: now() };
    while (queue.length >= maxQueue) {
      // Garder l'envoi en cours ; abandonner le plus ancien en attente.
      const old = queue[running ? 1 : 0];
      if (!old) { report("drop_capacity", { msg, queuedAt: now(), attempts: 0, resolve() {} }); return Promise.resolve(false); }
      remove(old, "drop_capacity");
    }
    if (identity) {
      seen.set(identity, { at: now(), eventId: msg.eventId, receivedAt: payload.receivedAt as number | undefined, sentAt: msg.sentAt });
      if (seen.size > 1000) seen.delete(seen.keys().next().value!);
    }
    const result = new Promise<boolean>((resolve) => queue.push({ msg, identity, queuedAt: now(), attempts: 0, resolve }));
    report("queued", queue.at(-1));
    if (!timer) void flush();
    return result;
  };
  return {
    enqueue, bridgeId,
    stop() {
      stopped = true; clearTimeout(timer); timer = undefined; send.stop();
      while (queue.length) remove(queue[0]!, "drop_shutdown"); seen.clear();
    },
    get size() { return queue.length; },
  };
}

let activeStop: (() => void) | undefined;
/** Hook officiel Orca : appelé avant l'arrêt du worker. */
export function deactivate(): void { activeStop?.(); activeStop = undefined; }

export default function activate(orca: OrcaApi, deps: BridgeDeps = {}): () => void {
  deactivate();
  const now = deps.now ?? Date.now;
  const queue = createDeliveryQueue({ log: (l) => orca.log(l), ...deps });
  void queue.enqueue({ kind: "hello" });
  const subscription = orca.events.on("agent.status.changed", (e) => queue.enqueue({
    kind: "agent", workspaceId: e.workspaceId, paneKey: e.paneKey, terminalId: e.terminalId,
    title: e.title, state: e.state, receivedAt: e.receivedAt ?? now(),
    outcome: e.mainAgent?.outcome, mainAgent: e.mainAgent ? { ...e.mainAgent } : undefined,
  }));
  // Ce signal prouve seulement que le worker vit, jamais la fraîcheur d'un agent.
  const heartbeat = setInterval(() => { if (!queue.size) void queue.enqueue({ kind: "heartbeat" }); }, Math.max(1000, deps.heartbeatMs ?? 60_000));
  heartbeat.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat); queue.stop();
    if (subscription && typeof subscription === "object" && "dispose" in subscription && typeof subscription.dispose === "function") subscription.dispose();
  };
  activeStop = stop;
  return stop;
}
