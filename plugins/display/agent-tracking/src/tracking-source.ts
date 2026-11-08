// Relais du service de suivi : lecture seule, changement de fournisseur et attentes bornées.
import type { AgentTrackingService, AgentTrackingSnapshot } from "@floppy/contracts";

/** Projection explicite : un champ ajouté au fournisseur ne traverse jamais le pont par accident. */
export function boundedTracking(value: AgentTrackingSnapshot): AgentTrackingSnapshot {
  const text = (s: string | undefined, max = 4000) => typeof s === "string" ? s.slice(0, max) : undefined;
  const at = (n: number) => Number.isFinite(n) && n >= 0 ? n : 0;
  const code = (s: string | undefined) => typeof s === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(s) ? s : undefined;
  return {
    at: at(value.at),
    connection: { state: value.connection.state, coverage: value.agents.length > 200 && value.connection.coverage === "full" ? "partial" : value.connection.coverage, lastSyncAt: value.connection.lastSyncAt === undefined ? undefined : at(value.connection.lastSyncAt) },
    agents: value.agents.slice(0, 200).map((a) => ({
      id: text(a.id, 300) ?? "", project: text(a.project, 200) ?? "", label: text(a.label, 200) ?? "", workspaceLabel: text(a.workspaceLabel, 200),
      activity: a.activity, outcome: a.outcome, presence: a.presence, observedAt: at(a.observedAt), lastSeenAt: at(a.lastSeenAt),
      mission: text(a.mission), details: text(a.details), progress: text(a.progress), waitingReason: text(a.waitingReason), declaredResult: text(a.declaredResult), lastAction: text(a.lastAction),
    })),
    events: value.events.slice(-300).map((e) => ({ eventId: text(e.eventId, 300) ?? "", agentId: text(e.agentId, 300) ?? "", at: at(e.at), kind: text(e.kind, 80) ?? "", summary: text(e.summary) })),
    diagnostics: value.diagnostics?.slice(-40).map((d) => ({
      at: at(d.at), reason: code(d.reason) ?? "source.metadata-unavailable", correlationId: code(d.correlationId), component: code(d.component), stage: code(d.stage),
      agentId: code(d.agentId), eventId: code(d.eventId), callId: code(d.callId),
    })),
  };
}

export function emptyTracking(): AgentTrackingSnapshot {
  return { at: Date.now(), agents: [], events: [], connection: { state: "unknown", coverage: "unknown" } };
}

export function watchTracking(deps: {
  service(): AgentTrackingService | undefined;
  changed(fn: (name: string) => void): () => void;
  publish(snapshot: AgentTrackingSnapshot): void;
}) {
  let current: AgentTrackingService | undefined;
  let unsubscribe: (() => void) | undefined;
  let last = emptyTracking();
  let stopped = false;
  let refreshing: Promise<boolean> | undefined;
  let controller: AbortController | undefined;
  const push = () => {
    if (stopped) return;
    try {
      if (current) last = boundedTracking(current.snapshot());
      else last = { ...last, connection: { ...last.connection, state: "offline", coverage: "outage" } };
    } catch { last = { ...last, connection: { ...last.connection, state: "stale", coverage: "partial" } }; }
    deps.publish(last);
  };
  const watch = () => {
    const next = deps.service();
    if (next !== current) {
      controller?.abort();
      unsubscribe?.(); unsubscribe = undefined;
      current = next;
      if (next) unsubscribe = next.subscribe(push);
    }
    push();
  };
  const unwatch = deps.changed((name) => { if (name === "agentTracking") watch(); });
  watch();
  return {
    get: push,
    refresh(): Promise<boolean> {
      if (stopped || !current) return Promise.resolve(false);
      if (refreshing) return refreshing;
      const svc = current;
      const abort = new AbortController(); controller = abort;
      let timer: ReturnType<typeof setTimeout>;
      // Le délai borne aussi un fournisseur qui ne respecte pas le signal.
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => { abort.abort(); resolve(false); }, 10_000);
        abort.signal.addEventListener("abort", () => resolve(false), { once: true });
      });
      refreshing = Promise.race([
        Promise.resolve().then(() => svc.refresh(abort.signal)).then(() => !abort.signal.aborted, () => false), expired,
      ]).then((ok) => { if (!stopped && current === svc) push(); return ok; }).finally(() => {
        clearTimeout(timer); if (controller === abort) controller = undefined; refreshing = undefined;
      });
      return refreshing;
    },
    stop() { stopped = true; controller?.abort(); unsubscribe?.(); unsubscribe = undefined; unwatch(); },
  };
}
