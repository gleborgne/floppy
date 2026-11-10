// Faits observés, distincts des annonces parlées. Aucun texte n'est envoyé aux diagnostics.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic, corruptFiles } from "@floppy/core";
import { z } from "zod";
import type { OrcaAgent, OrcaWorktree } from "./index.ts";

export type ActivityOutcome = "success" | "failure" | "interruption" | "unconfirmed" | "unknown";
export type AgentActivity = "working" | "waiting" | "finished" | "idle" | "unknown";
export type AgentPresence = "live" | "absent" | "unknown";
export interface ActivityIdentity { hostId: string; workspaceId: string; agentId: string; incarnation?: string }
export interface ActivityObservation {
  identity: ActivityIdentity;
  project: string;
  workspaceLabel?: string;
  label?: string;
  agentType?: string;
  state?: string;
  outcome?: ActivityOutcome;
  presence?: AgentPresence;
  declaredResult?: string;
  lastAction?: string;
  observedAt?: number;
  cycleId?: string;
  eventId?: string;
  provenance?: string;
}
export interface ActivitySnapshot {
  hostId: string;
  source: string;
  observedAt?: number;
  coverage: "full" | "partial" | "outage";
  /** Sans cette liste, full couvre tous les espaces de cet hôte. */
  workspaceIds?: string[];
  agents: ActivityObservation[];
}
const identitySchema = z.object({ hostId: z.string().min(1).max(512), workspaceId: z.string().min(1).max(512), agentId: z.string().min(1).max(512), incarnation: z.string().max(512).optional() });
const outcomeSchema = z.enum(["success", "failure", "interruption", "unconfirmed", "unknown"]);
const activitySchema = z.enum(["working", "waiting", "finished", "idle", "unknown"]);
const presenceSchema = z.enum(["live", "absent", "unknown"]);
const fields = {
  id: z.string().max(80), identity: identitySchema, project: z.string().max(240), workspaceLabel: z.string().max(160).optional(), label: z.string().max(160),
  activity: activitySchema, outcome: outcomeSchema, presence: presenceSchema,
  observedAt: z.number().finite(), lastSeenAt: z.number().finite(),
  declaredResult: z.string().max(600).optional(), lastAction: z.string().max(240).optional(),
  cycleId: z.string().max(160), provenance: z.string().max(120),
};
const recordSchema = z.object({ ...fields, baseLabel: z.string().max(120), fingerprint: z.string().max(80), presenceAt: z.number().finite() });
export type ActivityAgentRecord = z.infer<typeof recordSchema>;
const eventSchema = z.object({ ...fields, eventId: z.string().max(80), sourceEventId: z.string().max(160).optional(),
  kind: z.enum(["baseline", "transition", "observation", "presence", "delivery"]),
  previousActivity: activitySchema.optional(),
  delivery: z.enum(["accepted", "failed", "unconfirmed", "refused"]).optional(), correlationId: z.string().max(160).optional(),
});
export type ActivityEvent = z.infer<typeof eventSchema>;
export interface ActivityDiagnostic {
  type: "accepted" | "duplicate" | "stale" | "expired" | "coverage" | "transition" | "persistence";
  reason: string;
  at: number;
  observedAt?: number;
  agentId?: string;
  eventId?: string;
  correlationId?: string;
  count?: number;
}
export interface ActivityStoreOptions {
  home?: string;
  now?: () => number;
  diagnostics?: (diagnostic: ActivityDiagnostic) => void;
  persistence?: { read(file: string): unknown; write(file: string, value: unknown): void };
  retentionMs?: number;
  maxEvents?: number;
  liveMs?: number;
  absentMs?: number;
}
export interface ActivityDelivery {
  agentId: string;
  correlationId: string;
  delivery: "accepted" | "failed" | "unconfirmed" | "refused";
  observedAt?: number;
  provenance?: string;
}
export interface ActivityQuery { agentId?: string; project?: string; since?: number; limit?: number }
export interface ActivityStore {
  ingest(snapshot: ActivitySnapshot): ActivityEvent[];
  current(): ActivityAgentRecord[];
  query(query?: ActivityQuery): ActivityEvent[];
  appendDelivery(observation: ActivityDelivery): ActivityEvent | undefined;
  prune(): void;
  persist(): boolean;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const clip = (value: string | undefined, max: number): string | undefined => value?.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || undefined;
const humanLabel = (value: string | undefined, max: number): string | undefined => clip(value?.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:term|agent|task|run|worker-task)_[\w-]+\b/gi, ""), max);
export function activityAgentId(identity: ActivityIdentity): string {
  return `agent_${hash([identity.hostId, identity.workspaceId, identity.agentId, identity.incarnation ?? ""])}`;
}
/** Adaptateur de CLI : un paneKey seul ne permet pas de prouver une réutilisation du volet. */
export function activityObservation(w: OrcaWorktree, a: OrcaAgent, scope: { hostId: string; observedAt?: number; provenance?: string; presence?: AgentPresence }): ActivityObservation {
  const raw = a as OrcaAgent & { agentId?: string; sessionId?: string; incarnation?: string; outcome?: unknown; eventId?: string; hasLivePty?: boolean; mainAgent?: { outcome?: unknown } };
  const outcome = raw.mainAgent?.outcome ?? raw.outcome;
  const normalizedOutcome = typeof outcome === "string" ? outcome.toLowerCase() : "unknown";
  return {
    identity: { hostId: scope.hostId, workspaceId: w.worktreeId, agentId: raw.agentId ?? a.paneKey, incarnation: raw.incarnation ?? raw.sessionId },
    project: w.repo ?? w.displayName ?? w.worktreeId, workspaceLabel: w.displayName,
    label: a.taskTitle ?? a.conversationName ?? a.displayName ?? undefined, agentType: a.agentType,
    state: a.interrupted ? "interrupted" : a.state,
    outcome: /^(failure|failed|error)$/.test(normalizedOutcome) ? "failure"
      : /^(cancellation|cancelled|canceled|interrupted|interruption|aborted)$/.test(normalizedOutcome) ? "interruption"
      : /^(unconfirmed|unverified)$/.test(normalizedOutcome) ? "unconfirmed"
      : /^(success|succeeded)$/.test(normalizedOutcome) ? "success" : "unknown",
    presence: scope.presence ?? (raw.hasLivePty === true ? "live" : raw.hasLivePty === false ? "absent" : "unknown"),
    declaredResult: a.lastAssistantMessage ?? undefined, lastAction: a.toolName ?? undefined,
    observedAt: scope.observedAt, provenance: scope.provenance,
    // La date de l'état courant n'identifie pas un tour ; le pont peut conserver une ancienne date.
    eventId: raw.eventId,
  };
}
function classify(state: string | undefined, declared?: ActivityOutcome): { activity: AgentActivity; outcome: ActivityOutcome } {
  const s = state?.toLowerCase().trim();
  const outcome = outcomeSchema.safeParse(declared);
  if (["interrupted", "cancelled", "canceled", "aborted"].includes(s ?? "")) return { activity: "finished", outcome: "interruption" };
  if (["failed", "error", "failure"].includes(s ?? "")) return { activity: "finished", outcome: "failure" };
  const activity: AgentActivity = s === "working" || s === "running" ? "working"
    : s && /^(waiting|blocked|permission|needs.input)/.test(s) ? "waiting"
    : ["done", "finished", "completed", "success", "succeeded"].includes(s ?? "") ? "finished"
    : s === "idle" ? "idle" : "unknown";
  return { activity, outcome: outcome.success ? outcome.data : ["success", "succeeded"].includes(s ?? "") ? "success" : "unknown" };
}
const diskSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(5000), events: z.array(eventSchema).max(500), watermarks: z.array(z.tuple([z.string().max(80), z.number().finite()])).max(5000) });

export function createActivityStore(options: ActivityStoreOptions = {}): ActivityStore {
  const now = options.now ?? Date.now;
  const retention = Math.min(48 * 3600000, Math.max(1, options.retentionMs ?? 48 * 3600000));
  const cap = Math.min(500, Math.max(1, Math.floor(options.maxEvents ?? 500)));
  const liveMs = Math.max(1, options.liveMs ?? 120000);
  const absentMs = Math.min(retention, Math.max(liveMs, options.absentMs ?? 3600000));
  const file = join(options.home ?? ".", "orca-activity.json");
  const io = options.persistence ?? { read: readJsonFile<unknown>, write: writeJsonAtomic };
  const records = new Map<string, ActivityAgentRecord>();
  const watermarks = new Map<string, number>();
  let events: ActivityEvent[] = [];
  let readable = true;
  const diagnostic = (type: ActivityDiagnostic["type"], reason: string, extra: Omit<ActivityDiagnostic, "type" | "reason" | "at"> = {}): void => {
    try { options.diagnostics?.({ type, reason, at: now(), ...extra }); } catch { /* Un journal défaillant n'arrête pas les observations. */ }
  };
  const eventOf = (record: ActivityAgentRecord, kind: ActivityEvent["kind"], at: number, sourceEventId?: string): ActivityEvent => {
    const { baseLabel: _base, fingerprint: _fingerprint, presenceAt: _presenceAt, ...facts } = record;
    return { ...facts, kind, observedAt: at, eventId: `event_${randomUUID()}`, sourceEventId: clip(sourceEventId, 160) };
  };
  const accept = (event: ActivityEvent): void => {
    events.push(event);
    diagnostic("accepted", event.kind, { agentId: event.id, eventId: event.eventId, correlationId: event.correlationId });
  };
  const prune = (): void => {
    const at = now();
    const kept = events.filter((e) => {
      if (e.observedAt > at - retention) return true;
      diagnostic("expired", "retention", { agentId: e.id, eventId: e.eventId, observedAt: e.observedAt });
      return false;
    });
    events = kept.sort((a, b) => a.observedAt - b.observedAt).slice(-cap);
    for (const e of kept.slice(0, Math.max(0, kept.length - cap))) diagnostic("expired", "event_cap", { agentId: e.id, eventId: e.eventId, observedAt: e.observedAt });
    for (const [id, r] of records) {
      if (at - r.lastSeenAt >= absentMs) {
        records.delete(id);
        diagnostic("expired", "current_retention", { agentId: id });
      } else if (r.presence === "live" && at - r.lastSeenAt >= liveMs) {
        r.presence = "unknown";
        r.presenceAt = at;
        diagnostic("transition", "liveness_expired", { agentId: id });
      }
    }
    for (const [key, timestamp] of watermarks) if (timestamp <= at - retention) watermarks.delete(key);
  };
  if (options.home || options.persistence) {
    try {
      const corruptBefore = corruptFiles().length;
      const data = io.read(file);
      if (corruptFiles().length > corruptBefore) diagnostic("persistence", "corrupt_json");
      if (data !== undefined) {
        const parsed = diskSchema.safeParse(data);
        if (!parsed.success) { readable = false; diagnostic("persistence", "invalid_schema"); }
        else {
          for (const r of parsed.data.records) records.set(r.id, r);
          for (const [k, at] of parsed.data.watermarks) watermarks.set(k, at);
          events = parsed.data.events;
        }
      }
    } catch { readable = false; diagnostic("persistence", "read_failed"); }
  }
  prune();
  return {
    ingest(snapshot) {
      prune();
      const accepted: ActivityEvent[] = [];
      const at = snapshot.observedAt ?? now();
      if (!Number.isFinite(at) || at <= now() - retention || at > now() + 60000) { diagnostic("stale", "snapshot_time"); return accepted; }
      if (snapshot.coverage !== "full") diagnostic("coverage", snapshot.coverage === "outage" ? "source_outage" : "incomplete", { correlationId: hash([snapshot.hostId, snapshot.source]), observedAt: at });
      if (snapshot.coverage === "outage") return accepted;
      const seen = new Set<string>();
      for (const observation of snapshot.agents) {
        if (!identitySchema.safeParse(observation.identity).success || observation.identity.hostId !== snapshot.hostId) { diagnostic("stale", "invalid_identity"); continue; }
        const id = activityAgentId(observation.identity);
        seen.add(id);
        const observedAt = observation.observedAt ?? at;
        const previous = records.get(id);
        const scopeKey = hash(["workspace", snapshot.hostId, observation.identity.workspaceId]);
        if (!Number.isFinite(observedAt) || observedAt <= now() - retention || observedAt > now() + 60000 || observedAt < Math.max(previous?.observedAt ?? -Infinity, previous?.presenceAt ?? -Infinity, watermarks.get(scopeKey) ?? -Infinity, watermarks.get(hash(["host", snapshot.hostId])) ?? -Infinity)) {
          diagnostic("stale", "older_observation", { agentId: id }); continue;
        }
        const { activity, outcome } = classify(observation.state, observation.outcome);
        const presence = /^(dead|stopped|exited)$/i.test(observation.state ?? "") ? "absent" : observation.presence ?? "unknown";
        // Un agent déjà mort au premier relevé ne devient pas un agent courant.
        if (!previous && presence === "absent") { diagnostic("stale", "absent_without_live_record", { agentId: id, observedAt }); continue; }
        const project = clip(observation.project, 240) ?? observation.identity.workspaceId.slice(0, 240);
        const candidate = observation.label === observation.identity.agentId ? undefined : humanLabel(observation.label, 120);
        const meaningful = candidate && candidate !== observation.identity.agentId && !/^(agent|codex|claude|gemini|assistant|unknown)(\s+agent)?$/i.test(candidate)
          && !/^(?:term_|agent_|[a-f0-9]{8}-[a-f0-9-]{27,})/i.test(candidate);
        const type = /^(codex|claude|gemini|copilot|cursor|aider|opencode|pi|hermes)$/i.test(observation.agentType ?? "") ? ` ${observation.agentType}` : "";
        const fallback = `Agent${type} · ${humanLabel(observation.workspaceLabel, 60) ?? (project === observation.identity.workspaceId ? undefined : humanLabel(project, 60)) ?? "Orca"}`;
        const baseLabel = meaningful ? candidate : previous && !/^Agent(?: \w+)? · /.test(previous.baseLabel) ? previous.baseLabel : fallback;
        const usedLabels = new Set([...records.values(), ...events].filter((r) => r.id !== id).map((r) => r.label));
        let label = previous?.baseLabel === baseLabel ? previous.label : baseLabel;
        if (usedLabels.has(label)) {
          const contextual = `${baseLabel} (${clip(project, 24)})`;
          label = contextual;
          for (let n = 2; usedLabels.has(label); n++) label = `${baseLabel} (${n})`;
        }
        const record: ActivityAgentRecord = {
          id, identity: { ...observation.identity }, project, workspaceLabel: clip(observation.workspaceLabel, 160),
          baseLabel, label, activity, outcome, presence,
          observedAt, lastSeenAt: presence !== "absent" ? observedAt : previous?.lastSeenAt ?? observedAt, presenceAt: observedAt,
          declaredResult: clip(observation.declaredResult, 600), lastAction: clip(observation.lastAction, 240),
          cycleId: clip(observation.cycleId, 160) ?? (activity === "working" && previous?.activity !== "working" ? `cycle_${randomUUID()}` : previous?.cycleId ?? `cycle_${randomUUID()}`),
          provenance: clip(observation.provenance ?? snapshot.source, 120) ?? "unknown", fingerprint: "",
        };
        record.fingerprint = hash([record.activity, record.outcome, record.declaredResult, record.lastAction, record.cycleId]);
        const duplicateEvent = observation.eventId ? events.find((e) => e.id === id && e.sourceEventId === clip(observation.eventId, 160)) : undefined;
        if (duplicateEvent || (previous?.fingerprint === record.fingerprint && previous.presence === presence)) {
          // Un doublon plus récent confirme seulement la présence, pas une nouvelle fin.
          if (previous) {
            const renamed = previous.label !== label || previous.project !== project || previous.workspaceLabel !== record.workspaceLabel;
            Object.assign(previous, { baseLabel, label, project, workspaceLabel: record.workspaceLabel });
            if (presence !== "absent" && previous.presence === presence) previous.lastSeenAt = observedAt;
            previous.observedAt = observedAt; previous.presenceAt = observedAt;
            if (renamed) { const event = eventOf(previous, "observation", observedAt); accept(event); accepted.push(event); }
          }
          diagnostic("duplicate", "same_observation", { agentId: id, eventId: duplicateEvent?.eventId, observedAt }); continue;
        }
        if (previous && observedAt === previous.observedAt) { diagnostic("stale", "conflicting_same_time", { agentId: id }); continue; }
        records.set(id, record);
        const kind = !previous ? "baseline" : previous.activity !== record.activity || previous.outcome !== record.outcome || previous.cycleId !== record.cycleId ? "transition" : "observation";
        const event = eventOf(record, kind, observedAt, observation.eventId);
        event.previousActivity = previous?.activity;
        accept(event); accepted.push(event);
        if (previous) diagnostic("transition", `${previous.activity}_to_${record.activity}`, { agentId: id, eventId: event.eventId });
      }
      if (snapshot.coverage === "full") {
        const scopes = snapshot.workspaceIds;
        for (const r of records.values()) if (r.identity.hostId === snapshot.hostId && (!scopes || scopes.includes(r.identity.workspaceId)) && !seen.has(r.id) && at >= r.observedAt && at >= r.presenceAt && r.presence !== "absent") {
          r.presence = "absent"; r.presenceAt = at;
          const event = eventOf(r, "presence", at); accept(event); accepted.push(event);
          diagnostic("transition", "absent", { agentId: r.id, eventId: event.eventId });
        }
        for (const key of scopes ? scopes.map((w) => hash(["workspace", snapshot.hostId, w])) : [hash(["host", snapshot.hostId])]) watermarks.set(key, Math.max(at, watermarks.get(key) ?? -Infinity));
      }
      prune();
      return structuredClone(accepted);
    },
    current() { prune(); return structuredClone([...records.values()]); },
    query(query = {}) {
      prune();
      return structuredClone(events.filter((e) => (!query.agentId || e.id === query.agentId) && (!query.project || e.project === query.project) && (query.since === undefined || e.observedAt >= query.since)).slice(-Math.max(1, Math.min(cap, query.limit ?? cap))));
    },
    appendDelivery(observation) {
      prune();
      const r = records.get(observation.agentId);
      const at = observation.observedAt ?? now();
      const correlationId = clip(observation.correlationId, 160);
      if (!r || !correlationId || !Number.isFinite(at) || at <= now() - retention || at > now() + 60000) { diagnostic("stale", "delivery_target_or_time", { agentId: observation.agentId.slice(0, 80) }); return; }
      if (events.some((e) => e.id === r.id && e.kind === "delivery" && e.correlationId === correlationId && e.delivery === observation.delivery)) { diagnostic("duplicate", "delivery", { agentId: r.id, correlationId }); return; }
      const event = { ...eventOf(r, "delivery", at), correlationId, delivery: observation.delivery, provenance: clip(observation.provenance, 120) ?? "instruction_delivery" };
      accept(event); prune(); return structuredClone(event);
    },
    prune,
    persist() {
      prune();
      if (!readable) { diagnostic("persistence", "unsafe_overwrite_refused"); return false; }
      if (!options.home && !options.persistence) return true;
      try { io.write(file, { version: 1, records: [...records.values()], events, watermarks: [...watermarks] }); return true; }
      catch { diagnostic("persistence", "write_failed"); return false; }
    },
  };
}
