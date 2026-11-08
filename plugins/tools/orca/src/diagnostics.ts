import type { Context, ToolCallMeta } from "@floppy/core";

export interface OrcaTrace {
  at: number;
  stage: string;
  reason?: string;
  eventId?: string;
  agentId?: string;
  callId?: string;
  turn?: string;
  session?: string;
  count?: number;
  queueLength?: number;
  sourceAgeMs?: number;
  latencyMs?: number;
  contextAgeMs?: number | null;
  selectedIds?: string[];
}
/** Le journal conserve seulement ces métadonnées, jamais les arguments ou messages bruts. */
export function createOrcaDiagnostics(ctx: Pick<Context, "audit">, now: () => number = Date.now) {
  const recent: OrcaTrace[] = [];
  // Les observations routinières ont des compteurs bornés, hors du journal des décisions.
  const routine = new Map<string, OrcaTrace>();
  function record(stage: string, data: Omit<Partial<OrcaTrace>, "at" | "stage"> = {}, meta?: ToolCallMeta): void {
    const aggregated = stage === "poll.started" || stage === "poll.completed" || stage === "poll.source_older" || stage === "activity.duplicate" && data.reason === "same_observation" || stage === "activity.coverage" && data.reason === "incomplete"
      || stage === "bridge.liveness" && data.reason === "heartbeat" || stage === "bridge.transport" && data.reason === "heartbeat_accepted";
    const key = `${stage}:${data.reason ?? ""}`;
    if (aggregated) {
      const previous = routine.get(key);
      if (previous) { previous.at = now(); previous.count = Math.min(Number.MAX_SAFE_INTEGER, (previous.count ?? 1) + 1); return; }
    }
    const entry: OrcaTrace = { at: now(), stage: stage.slice(0, 80) };
    for (const key of ["reason", "eventId", "agentId", "callId", "turn", "session"] as const) {
      const value = key === "callId" || key === "turn" || key === "session" ? meta?.[key] ?? data[key] : data[key];
      if (typeof value === "string") entry[key] = value.slice(0, 160);
    }
    for (const key of ["count", "queueLength", "sourceAgeMs", "latencyMs", "contextAgeMs"] as const) {
      const value = data[key];
      if (typeof value === "number" && Number.isFinite(value)) entry[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
      else if (key === "contextAgeMs" && value === null) entry.contextAgeMs = null;
    }
    if (data.selectedIds) entry.selectedIds = data.selectedIds.slice(0, 64).map((id) => id.slice(0, 80));
    if (aggregated) {
      delete entry.agentId; delete entry.eventId;
      entry.count = 1; routine.set(key, entry);
      while (routine.size > 8) routine.delete(routine.keys().next().value!);
    }
    else recent.push(entry);
    prune();
    ctx.audit.write({ kind: "orca", ...entry });
  }
  function prune(): void {
    for (const [key, entry] of routine) if (entry.at < now() - 48 * 3600_000) routine.delete(key);
    while (recent.length && (recent.length + routine.size > 300 || recent[0]!.at < now() - 48 * 3600_000)) recent.shift();
  }
  return { record, recent(limit = 50): OrcaTrace[] { prune(); return structuredClone([...recent, ...routine.values()].sort((a, b) => a.at - b.at).slice(-Math.min(100, Math.max(1, limit)))); } };
}
