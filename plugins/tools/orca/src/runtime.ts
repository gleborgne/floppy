// Collection des faits, références de conversation et diagnostics : aucune dépendance au démarrage du plugin.
import { fold, T, type Context, type ToolCallMeta, type ToolOutput } from "@floppy/core";
import { activityAgentId, activityObservation, createActivityStore, type ActivityAgentRecord, type ActivityDelivery, type ActivityEvent } from "./activity.ts";
import { createAgentReferences, type AgentReference, type ReferenceFailure } from "./references.ts";
import { createOrcaDiagnostics } from "./diagnostics.ts";
import type { BridgeEvent, BridgeDiagnostic } from "./bridge.ts";
import type { Hit, OrcaAgent, OrcaCli, OrcaRunner, OrcaWorktree } from "./index.ts";
import { cleanTask, projectName } from "./speech.ts";
import { checkoutProtection, type ProtectedObservation } from "./checkout-protection.ts";

export interface OrcaEnvelope {
  worktrees?: OrcaWorktree[];
  runtimeId?: string;
  hostScope?: unknown;
  truncated?: boolean;
  totalCount?: number;
}
export interface OrcaSnapshot {
  at: number;
  agents: ActivityAgentRecord[];
  events: ActivityEvent[];
  connection: { state: "connected" | "stale" | "offline" | "unknown"; lastSyncAt?: number; coverage: "full" | "partial" | "outage" | "unknown" };
  scope: Pick<OrcaEnvelope, "runtimeId" | "hostScope" | "truncated" | "totalCount">;
  diagnostics: ReturnType<ReturnType<typeof createOrcaDiagnostics>["recent"]>;
}
export interface OrcaRuntimeOptions {
  ctx: Context;
  cli: OrcaCli;
  run?: OrcaRunner;
  now: () => number;
  onChanges(events: ActivityEvent[], hits: Hit[]): void;
}
export type ReferencedAgent = AgentReference & { record: ActivityAgentRecord; hit?: Hit };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const normalized = (value: string): string => fold(value);
export const referenceOrigin = (meta: ToolCallMeta): string => JSON.stringify([meta.origin ?? "cli", meta.session ?? meta.origin ?? "cli"]);
function scopeHasGaps(value: unknown): boolean {
  const scope = object(value);
  if (!Object.keys(scope).length) return value !== undefined;
  if (scope.complete === false || scope.coverage === "partial" || scope.coverage === "outage") return true;
  for (const [key, item] of Object.entries(scope)) {
    if (/not.?covered|uncovered|omitted|missing|errors|gaps/i.test(key) && (Array.isArray(item) ? item.length > 0 : !!item)) return true;
    if (key === "covered" && item === false) return true;
    if (Array.isArray(item) && item.some((entry) => typeof entry === "object" && entry !== null && scopeHasGaps(entry))) return true;
  }
  // Une enveloppe inconnue ne permet pas de conclure à une couverture totale.
  return !(scope.complete === true || scope.coverage === "full" || Object.keys(scope).some((key) => /covered|hostIds/i.test(key)));
}
export function referenceFailure(reason: ReferenceFailure, candidates: readonly AgentReference[] = []): ToolOutput {
  const names = candidates.slice(0, 6).map((r) => `${r.label} (${r.project})`).join(" ; ");
  const suffix = names ? ` ${names}` : "";
  const messages: Record<ReferenceFailure, ReturnType<typeof T>> = {
    ambiguous: T(`Plusieurs agents correspondent. Précise la tâche ou le nom de l'agent.${suffix}`, `Several agents match. Specify the task or agent name.${suffix}`),
    expired: T("La référence de cette conversation a expiré. Redemande la liste ou nomme l'agent.", "This conversation reference has expired. Ask for the list again or name the agent."),
    missing: T("L'agent référencé n'est plus disponible dans le relevé actuel. Aucun autre agent ne le remplace.", "The referenced agent is no longer available in the current snapshot. No other agent replaces it."),
    notfound: T("Aucun agent Orca ne correspond à cette référence. Précise son nom ou sa tâche.", "No Orca agent matches this reference. Specify its name or task."),
    no_context: T("Quel agent ? Demande la liste ou donne son nom ou sa tâche dans cette conversation.", "Which agent? Ask for the list or give its name or task in this conversation."),
    cardinality: T("Cette référence désigne un groupe incompatible avec cette demande. Précise les agents.", "This reference identifies a group incompatible with this request. Specify the agents."),
  };
  return { status: "failed", text: messages[reason], raw: { reason, candidates: candidates.map(({ identity, label, project }) => ({ identity, label, project })) } };
}

export function createOrcaRuntime({ ctx, cli, run, now, onChanges }: OrcaRuntimeOptions) {
  const protection = checkoutProtection(ctx, { now });
  const protectionPushes = new Map<string, ProtectedObservation>();
  let protectionRevision = 0;
  const diagnostics = createOrcaDiagnostics(ctx, now);
  const store = createActivityStore({ home: ctx.home, now, diagnostics: (e) => diagnostics.record(`activity.${e.type}`, { reason: e.reason, agentId: e.agentId, eventId: e.eventId, count: e.count, sourceAgeMs: e.observedAt === undefined ? undefined : now() - e.observedAt }) });
  let correlation: ToolCallMeta | undefined;
  const references = createAgentReferences({ now, diagnostic: (e) => diagnostics.record(`reference.${e.mode}`, { selectedIds: e.selectedIds, count: e.matchCount, contextAgeMs: e.contextAgeMs, reason: e.reason }, correlation) });
  let wts: OrcaWorktree[] = [];
  let scope: OrcaSnapshot["scope"] = {};
  let connection: OrcaSnapshot["connection"] = { state: "unknown", coverage: "unknown" };
  let inflight: Promise<OrcaWorktree[]> | undefined;
  let stamp = 0;
  let dirty = false;
  let enrichmentScheduled = false;
  let bridgeId: string | undefined;
  let bridgeSeenAt: number | undefined;
  let stopped = false;
  const listeners = new Set<() => void>();
  const pushed = new Map<string, { at: number; sourceAt?: number; agent: OrcaAgent }>();
  const announcements = new Map<string, { at: number; references: AgentReference[] }>();
  // Corrèle l'acquittement de transport au seul battement accepté, sans masquer les agents.
  const heartbeatReceipts = new Set<string>();
  const receiptKey = (e: { bridgeId?: string; eventId?: string }): string => JSON.stringify([e.bridgeId, e.eventId]);
  const clock = (): number => (stamp = Math.max(now(), stamp + 0.001));
  const hostFor = (w: OrcaWorktree): string => text(object(w).hostId) ?? text(object(object(w).host).id) ?? text(object(w).host) ?? "local";
  const keyFor = (w: OrcaWorktree, a: OrcaAgent): string => `${hostFor(w)}|${w.worktreeId}|${a.paneKey}`;
  const allHits = (): Hit[] => wts.flatMap((w) => (w.agents ?? []).map((a) => ({ w, a })));
  const idOf = (w: OrcaWorktree, a: OrcaAgent): string => activityAgentId(activityObservation(w, a, { hostId: hostFor(w) }).identity);
  function changed(): void { for (const listener of listeners) { try { listener(); } catch { /* Abonné indépendant de la collecte. */ } } }
  function persistSoon(): void {
    if (dirty) return;
    dirty = true;
    ctx.timeout(() => { dirty = false; if (!stopped) store.persist(); }, 100);
  }
  function currentReferences(): ReferencedAgent[] {
    const hits = new Map(allHits().map((hit) => [idOf(hit.w, hit.a), hit]));
    return store.current().filter((r) => r.presence !== "absent").map((record) => {
      const hit = hits.get(record.id);
      return { identity: record.id, label: record.label, project: record.project, aliases: [record.baseLabel, record.workspaceLabel ?? "", ...(hit ? [hit.w.branch ?? "", projectName(hit.w), cleanTask(hit.a), hit.a.displayName ?? "", hit.a.conversationName ?? ""] : [])].filter(Boolean), record, hit };
    });
  }
  function expireMaps(): void {
    for (const [key, event] of announcements) if (now() - event.at >= 10 * 60_000) announcements.delete(key);
    while (announcements.size > 300) announcements.delete(announcements.keys().next().value!);
    for (const [key, value] of pushed) if (now() - value.at > 48 * 3600_000) pushed.delete(key);
    while (pushed.size > 500) pushed.delete(pushed.keys().next().value!);
  }
  const stop = new AbortController();
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), stop.signal]);
    let listener: () => void = () => {};
    const timeout = new Promise<never>((_, reject) => { listener = () => reject(new Error("orca_timeout")); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); });
    try { return await Promise.race([promise, timeout]); } finally { signal.removeEventListener("abort", listener); }
  }
  async function collect(): Promise<OrcaWorktree[]> {
    const startedAt = now();
    const protectionSample = protection.capture();
    const protectedPushes = [...protectionPushes.values()];
    protectionPushes.clear();
    diagnostics.record("poll.started");
    try {
      const raw = run ? { worktrees: await bounded(run()) } : object(await bounded(cli(["worktree", "ps"])));
      if (stopped || !ctx.alive) return wts;
      if (!Array.isArray(raw.worktrees)) throw new Error("invalid_snapshot");
      const incoming = raw.worktrees as OrcaWorktree[];
      protectionSample.at = now();
      const protectionRows = incoming.map(w => ({ ...w, agents: (w.agents ?? []).map(a => ({ ...a, state: a.mainAgent?.state ?? a.state, stateStartedAt: a.mainAgent?.stateStartedAt ?? a.stateStartedAt })) }));
      scope = { runtimeId: text(raw.runtimeId), hostScope: raw.hostScope, truncated: raw.truncated === true, totalCount: finite(raw.totalCount) };
      // Tout scope inconnu est conservateur : seul un relevé complet prouve une disparition.
      const partial = raw.truncated === true || (typeof raw.totalCount === "number" && raw.totalCount > incoming.length) || scopeHasGaps(raw.hostScope);
      const observedAt = clock();
      const next = incoming.map((w) => ({ ...w, agents: (w.agents ?? []).map((a) => {
        a = { ...a, state: a.mainAgent?.state ?? a.state, stateStartedAt: a.mainAgent?.stateStartedAt ?? a.stateStartedAt };
        const pushedEvent = pushed.get(keyFor(w, a));
        if (!pushedEvent) return a;
        const pollSourceAt = a.updatedAt ?? a.stateStartedAt;
        const newer = pollSourceAt !== undefined && pushedEvent.sourceAt !== undefined && pollSourceAt > pushedEvent.sourceAt;
        if (newer) { pushed.delete(keyFor(w, a)); return a; }
        // L'heure de collecte ne rend pas un ancien état de la CLI plus récent que le push.
        if (pollSourceAt === undefined || pushedEvent.sourceAt === undefined || pollSourceAt <= pushedEvent.sourceAt || now() - pushedEvent.at < 30_000) {
          diagnostics.record("poll.source_older", { agentId: idOf(w, a), reason: "push_state_preserved" });
          return { ...a, state: pushedEvent.agent.state, mainAgent: pushedEvent.agent.mainAgent, outcome: pushedEvent.agent.outcome, stateStartedAt: pushedEvent.agent.stateStartedAt ?? a.stateStartedAt };
        }
        return a;
      }) }));
      wts = partial ? [...new Map([...wts, ...next.map((w) => {
        const previous = wts.find((old) => old.worktreeId === w.worktreeId && hostFor(old) === hostFor(w));
        return { ...w, agents: [...new Map([...(previous?.agents ?? []), ...(w.agents ?? [])].map((a) => [a.paneKey, a])).values()] };
      })].map((w) => [`${hostFor(w)}|${w.worktreeId}`, w])).values()] : next;
      const grouped = new Map<string, OrcaWorktree[]>();
      for (const w of next) { const host = hostFor(w); grouped.set(host, [...(grouped.get(host) ?? []), w]); }
      const coveredHosts = object(raw.hostScope).hostIds;
      if (!partial && Array.isArray(coveredHosts)) for (const host of coveredHosts) if (typeof host === "string" && !grouped.has(host)) grouped.set(host, []);
      if (!grouped.size) grouped.set("local", []);
      const events: ActivityEvent[] = [];
      for (const [hostId, worktrees] of grouped) events.push(...store.ingest({ hostId, source: "cli", observedAt, coverage: partial ? "partial" : "full", agents: worktrees.flatMap((w) => (w.agents ?? []).map((a) => ({ ...activityObservation(w, a, { hostId, observedAt, provenance: "cli" }), label: cleanTask(a) || a.agentType || "Agent" }))) }));
      const retained = new Set(store.current().filter((r) => r.presence !== "absent").map((r) => r.id));
      wts = wts.map((w) => ({ ...w, agents: (w.agents ?? []).filter((a) => retained.has(idOf(w, a))) })).filter((w) => w.agents.length);
      connection = { state: "connected", lastSyncAt: now(), coverage: partial ? "partial" : "full" };
      diagnostics.record("poll.completed", { count: next.reduce((n, w) => n + (w.agents?.length ?? 0), 0), reason: partial ? "partial" : "full", latencyMs: now() - startedAt });
      const revision = protectionRevision;
      const applied = await protection.collect(protectionRows, args => bounded(cli(args)), protectionSample, protectedPushes, () => !stopped && ctx.alive && revision === protectionRevision);
      if (stopped || !ctx.alive) return wts;
      if (!applied && revision !== protectionRevision && protectionPushes.size) {
        // Un push arrivé pendant la lecture des terminaux invalide ce callback. Garder les transitions
        // pour la collecte déjà demandée par ce push, sans relancer sur une simple panne de transport.
        for (const o of [...protectedPushes, ...protectionRows.flatMap(w => (w.agents ?? []).map(a => ({ hit: { w, a }, sample: protectionSample })))]) keepProtected(o);
      }
      if (protectionPushes.size) scheduleSync();
      persistSoon(); expireMaps(); changed(); onChanges(events, allHits());
      return next;
    } catch (error) {
      if (!stopped) {
        connection = { ...connection, state: "offline", coverage: "outage" };
        store.ingest({ hostId: "local", source: "cli", observedAt: now(), coverage: "outage", agents: [] });
        diagnostics.record("poll.failed", { reason: "cli_unavailable", latencyMs: now() - startedAt }); changed();
      }
      throw error;
    }
  }
  function sync(): Promise<OrcaWorktree[]> {
    if (stopped || !ctx.alive) return Promise.reject(new Error("orca_stopped"));
    if (!inflight) inflight = collect().finally(() => { inflight = undefined; });
    return inflight;
  }
  function scheduleSync(): void {
    if (enrichmentScheduled || stopped) return;
    enrichmentScheduled = true;
    ctx.timeout(() => { enrichmentScheduled = false; if (!stopped) void sync().catch(() => {}); }, 0);
  }
  function keepProtected(o: ProtectedObservation): void {
    const operation = protection.protectedOperation(o.hit, o.sample);
    if (!operation || !/^(working|done|completed|idle)$/.test(o.hit.a.state ?? "")) return;
    const key = `${operation}:${o.hit.a.state === "working" ? "working" : "end"}`;
    const previous = protectionPushes.get(key);
    const at = o.hit.a.mainAgent?.stateStartedAt ?? o.hit.a.stateStartedAt;
    const previousAt = previous?.hit.a.mainAgent?.stateStartedAt ?? previous?.hit.a.stateStartedAt;
    if (at === undefined || !Number.isFinite(at) || (previousAt !== undefined && previousAt > at) || (previous?.sample.order ?? 0) >= o.sample.order) return;
    protectionPushes.set(key, { hit: { w: { ...o.hit.w, agents: undefined }, a: { ...o.hit.a, mainAgent: o.hit.a.mainAgent && { ...o.hit.a.mainAgent } } }, sample: { ...o.sample, operations: new Map([...o.sample.operations].filter(([, value]) => value.operation === operation)) } });
    while (protectionPushes.size > 1600) protectionPushes.delete(protectionPushes.keys().next().value!);
  }
  function acceptBridge(e: BridgeEvent): void {
    if (stopped || !ctx.alive) return;
    const receipt = receiptKey(e);
    if (e.kind === "heartbeat") {
      heartbeatReceipts.add(receipt);
      while (heartbeatReceipts.size > 32) heartbeatReceipts.delete(heartbeatReceipts.values().next().value!);
    } else heartbeatReceipts.delete(receipt);
    bridgeSeenAt = now();
    const restart = e.bridgeId !== undefined && bridgeId !== e.bridgeId;
    if (restart) { bridgeId = e.bridgeId; diagnostics.record("bridge.session", { reason: "reconcile", eventId: e.eventId }); scheduleSync(); }
    if (e.kind !== "agent") { diagnostics.record("bridge.liveness", { reason: String(e.kind) }); changed(); return; }
    if (typeof e.workspaceId !== "string" || typeof e.paneKey !== "string") { diagnostics.record("bridge.unmapped", { reason: "missing_workspace", eventId: e.eventId }); return; }
    const w = wts.find((w) => w.worktreeId === e.workspaceId) ?? { worktreeId: e.workspaceId };
    const old = w.agents?.find((a) => a.paneKey === e.paneKey);
    const a: OrcaAgent = { ...old, paneKey: e.paneKey, taskTitle: typeof e.title === "string" && e.title.trim() ? e.title : old?.taskTitle, state: e.mainAgent?.state ?? String(e.state ?? "unknown"), outcome: e.mainAgent?.outcome ?? (typeof e.outcome === "string" ? e.outcome : undefined), mainAgent: e.mainAgent, stateStartedAt: e.mainAgent?.stateStartedAt ?? old?.stateStartedAt };
    const eventAt = e.receivedAt ?? e.sentAt ?? now();
    const previous = pushed.get(keyFor(w, a));
    if (previous && eventAt < previous.at) { diagnostics.record("bridge.stale", { reason: "older_source", eventId: e.eventId }); return; }
    pushed.set(keyFor(w, a), { at: eventAt, sourceAt: e.mainAgent?.stateStartedAt ?? e.receivedAt ?? e.sentAt, agent: a });
    protectionRevision++;
    // Le pont ne porte pas les générations : la collecte suivante doit confirmer l'identité courante.
    // Un changement d'état sans son horodatage ne réutilise pas celui de l'ancien état comme preuve.
    keepProtected({ hit: { w, a: { ...a, stateStartedAt: e.mainAgent?.stateStartedAt, mainAgent: e.mainAgent ? { ...old?.mainAgent, ...e.mainAgent } : undefined } }, sample: protection.capture() });
    const updated = { ...w, agents: [...(w.agents ?? []).filter((existing) => existing.paneKey !== a.paneKey), a] };
    wts = [...wts.filter((existing) => existing.worktreeId !== w.worktreeId), updated];
    const observedAt = clock();
    const observation = activityObservation(updated, a, { hostId: hostFor(w), observedAt, provenance: "bridge", presence: "unknown" });
    observation.eventId = e.eventId;
    const events = store.ingest({ hostId: hostFor(w), source: "bridge", observedAt, coverage: "partial", agents: [observation] });
    diagnostics.record("bridge.accepted", { eventId: e.eventId, agentId: idOf(w, a), sourceAgeMs: now() - eventAt, count: events.length });
    persistSoon(); expireMaps(); changed(); onChanges(events, allHits()); scheduleSync();
  }
  function resolve(nom: string, meta: ToolCallMeta, many = false) {
    correlation = meta;
    try {
      const live = currentReferences();
      const exact = live.find((r) => r.identity === nom);
      if (exact) { references.focus(referenceOrigin(meta), exact); diagnostics.record("reference.identity", { selectedIds: [exact.identity], count: 1 }, meta); return { ok: true as const, references: [exact] }; }
      const knownId = store.current().find((r) => r.id === nom);
      if (knownId) {
        references.focus(referenceOrigin(meta), { identity: knownId.id, label: knownId.label, project: knownId.project });
        return references.resolve(referenceOrigin(meta), live);
      }
      return references.resolve(referenceOrigin(meta), live, { target: nom, cardinality: many ? "many" : "one" });
    } finally { correlation = undefined; }
  }
  ctx.hook("initiative.presented", async (event, next) => {
    if (event.source === "orca" && event.key) {
      expireMaps();
      const announced = announcements.get(event.key);
      diagnostics.record(`announcement.${event.stage}`, { eventId: event.key, count: announced?.references.length ?? 0 });
      // Une bulle en arrière-plan ne choisit jamais le sujet du prochain tour utilisateur.
      if (event.stage === "scheduled") {
        if (announced) references.rememberPresented(referenceOrigin(event), announced.references, event.key);
        else {
          // Une annonce trop ancienne ne laisse pas « lui » viser silencieusement l'ancien focus.
          references.clear(referenceOrigin(event));
          diagnostics.record("reference.invalidated", { reason: "announcement_reference_expired" });
        }
      }
      if (event.stage === "interrupted") references.revokeAnnouncement(referenceOrigin(event), event.key);
    }
    return next(event);
  });
  ctx.hook("initiative.delivery", async (event, next) => {
    if (event.source === "orca") {
      const known = event.key && announcements.has(event.key);
      diagnostics.record(`announcement.${event.stage}`, { eventId: known ? event.key : undefined, queueLength: event.queueLength, reason: event.stage === "dropped" ? "conversation_queue_capacity" : undefined });
    }
    return next(event);
  });
  ctx.effect(() => { stopped = true; stop.abort(); store.persist(); references.clear(); listeners.clear(); announcements.clear(); pushed.clear(); heartbeatReceipts.clear(); protectionPushes.clear(); });
  return {
    store, diagnostics, sync, acceptBridge, resolve, currentReferences, idOf,
    appendDelivery(fact: ActivityDelivery): void { store.appendDelivery(fact); persistSoon(); changed(); },
    bridgeDiagnostic(e: BridgeDiagnostic): void {
      const key = receiptKey(e);
      const heartbeat = e.reason === "accepted" && heartbeatReceipts.has(key);
      if (e.reason === "accepted" || e.reason === "acceptance_failed") heartbeatReceipts.delete(key);
      diagnostics.record("bridge.transport", { reason: heartbeat ? "heartbeat_accepted" : e.reason, eventId: e.eventId, queueLength: e.queueLength, sourceAgeMs: e.sourceLatencyMs });
    },
    bridgeLive(): boolean { return bridgeSeenAt !== undefined && now() - bridgeSeenAt < 10 * 60_000; },
    rememberPresented(meta: ToolCallMeta, refs: AgentReference[]): void { references.rememberPresented(referenceOrigin(meta), refs); },
    rememberAnnouncement(key: string, refs: AgentReference[]): void { announcements.set(key, { at: now(), references: refs }); expireMaps(); },
    resolveHistorical(nom: string, meta: ToolCallMeta) {
      const historical = [...new Map(store.query().map((e) => [e.id, { identity: e.id, label: e.label, project: e.project, aliases: [e.workspaceLabel ?? ""] }])).values()];
      correlation = meta;
      try {
        const exact = historical.find((ref) => ref.identity === nom);
        if (exact) { references.focus(referenceOrigin(meta), exact); return { ok: true as const, references: [exact] }; }
        return references.resolve(referenceOrigin(meta), historical, { target: nom, cardinality: "one" });
      } finally { correlation = undefined; }
    },
    resolveTarget(worktrees: OrcaWorktree[], nom: string, meta: ToolCallMeta = {}): Hit | ToolOutput {
      const result = resolve(nom, meta);
      if (!result.ok) return referenceFailure(result.reason, result.candidates);
      const id = result.references[0]?.identity;
      for (const w of worktrees) for (const a of w.agents ?? []) if (idOf(w, a) === id) return { w, a };
      return referenceFailure("missing");
    },
    snapshot(): OrcaSnapshot {
      const state = connection.state === "connected" && connection.lastSyncAt !== undefined && now() - connection.lastSyncAt > 120_000 ? "stale" : connection.state;
      return { at: now(), agents: store.current(), events: store.query({ limit: 100 }), connection: { ...connection, state }, scope: structuredClone(scope), diagnostics: diagnostics.recent() };
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type OrcaRuntime = ReturnType<typeof createOrcaRuntime>;

export function filterAgent(record: ActivityAgentRecord, args: Record<string, unknown>, now: number): boolean {
  const project = String(args.projet ?? args.project ?? "");
  if (project && !normalized(`${record.project} ${record.workspaceLabel ?? ""}`).includes(normalized(project))) return false;
  const status = String(args.filtre ?? "tous");
  if (status === "en_cours" && record.activity !== "working" || status === "en_attente" && record.activity !== "waiting" || status === "termines" && record.activity !== "finished" || status === "interrompu" && record.outcome !== "interruption") return false;
  if (args.depuis !== undefined) {
    const since = typeof args.depuis === "number" ? args.depuis : Date.parse(String(args.depuis));
    if (!Number.isFinite(since) || since > now || record.observedAt < since) return false;
  }
  return true;
}
