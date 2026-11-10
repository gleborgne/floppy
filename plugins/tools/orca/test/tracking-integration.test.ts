import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type Context, type ToolCallMeta } from "@floppy/core";
import type { AgentTrackingService, InitiativePresented } from "@floppy/contracts";
import { cliResult, createOrcaPlugin, type OrcaOptions, type OrcaWorktree } from "../src/index.ts";
import { createOrcaRuntime, type OrcaEnvelope } from "../src/runtime.ts";
import { startBridge } from "../src/bridge.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const meta = (origin = "voice", session = origin): ToolCallMeta => ({ origin, session });
const agent = (name: string, state = "working", extra = {}) => ({ paneKey: `tab:${name}`, taskTitle: name, agentType: "codex", state, stateStartedAt: NOW - 1000, hasLivePty: true, ...extra });
const worktree = (...agents: ReturnType<typeof agent>[]): OrcaWorktree => ({ worktreeId: "workspace", repo: "Floppy", displayName: "Floppy", agents });
const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function start(extra: { options?: Partial<OrcaOptions>; home?: string; config?: Record<string, unknown> } = {}) {
  let now = NOW;
  const state = { envelope: { worktrees: [worktree(agent("Filtrage mails"), agent("Réveil avatar"), agent("Analyse mémoire"))], runtimeId: "runtime-a", hostScope: { complete: true } } as OrcaEnvelope, offline: false };
  const home = extra.home ?? mkdtempSync(join(tmpdir(), "orca-tracking-"));
  const calls: string[][] = [];
  const cli = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "worktree") { if (state.offline) throw new Error("private path C:/secret/prompt-token"); return structuredClone(state.envelope); }
    if (args[0] === "terminal" && args[1] === "list") return { terminals: [{ handle: "term_mail", worktreeId: "workspace", tabId: "tab", leafId: "Filtrage mails" }] };
    if (args[0] === "terminal" && args[1] === "read") return { terminal: { tail: ["Question exacte"] } };
    if (args.includes("--index-status")) return { phase: "indexing" };
    if (args[0] === "search") return { kind: "results", hits: [], truncated: true, nextCursor: "opaque-cursor" };
    throw new Error("unexpected simulated command");
  });
  let ctx!: Context;
  let tracking!: AgentTrackingService;
  const probe = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT", inject: ["agentTracking"] }, apply(c) { ctx = c; tracking = c.get("agentTracking"); } });
  const k = new Kernel({ logger: () => {}, home, plugins: [createOrcaPlugin({ cli, now: () => now, bridge: false, phrase: async () => undefined, ...extra.options }), probe] });
  kernels.push(k);
  const announcements: { source: string; text: string; key?: string; importance: string }[] = [];
  k.bus.on("initiative", (event) => announcements.push(event));
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 600, ...extra.config } }, { id: "probe", plugin: "probe" }] });
  await tracking.refresh();
  return { k, state, home, calls, tracking, announcements, advance(ms = 10) { now += ms; },
    async presented(key: string, origin = "voice", stage: InitiativePresented["stage"] = "scheduled") { await ctx.runHook("initiative.presented", { origin, session: origin, source: "orca", key, stage }, async () => {}); },
  };
}
const raw = (result: { raw?: unknown }) => result.raw as Record<string, any>;

describe("suivi Orca intégré au noyau", () => {
  it("un pont sans titre garde une identité stable puis accepte les titres courants", async () => {
    let time = NOW;
    const state: OrcaWorktree[] = [{ worktreeId: "workspace", repo: "Floppy", agents: [{ paneKey: "raw-pane-key", agentType: "codex", state: "working", hasLivePty: true }] }];
    const ctx = { home: mkdtempSync(join(tmpdir(), "orca-labels-")), alive: true, audit: { write() {} }, timeout() {}, hook() {}, effect() {} } as unknown as Context;
    const runtime = createOrcaRuntime({ ctx, cli: async () => ({}), run: async () => state, now: () => time, onChanges() {} });
    runtime.acceptBridge({ kind: "agent", workspaceId: "workspace", paneKey: "raw-pane-key", state: "working" });
    const id = runtime.snapshot().agents[0]!.id;
    expect(runtime.snapshot().agents[0]!.label).not.toContain("raw-pane-key");
    time++; state[0]!.agents![0]!.taskTitle = "Fix login"; await runtime.sync();
    expect(runtime.snapshot().agents[0]).toMatchObject({ id, label: "Fix login" });
    time++; runtime.acceptBridge({ kind: "agent", workspaceId: "workspace", paneKey: "raw-pane-key", state: "working", title: "New mission" });
    expect(runtime.snapshot().agents[0]).toMatchObject({ id, label: "New mission" });
    time++; runtime.acceptBridge({ kind: "agent", workspaceId: "workspace", paneKey: "raw-pane-key", state: "working" });
    expect(runtime.snapshot().agents[0]).toMatchObject({ id, label: "New mission" });
  });

  it("une demande d'affichage ne choisit aucun contexte, même sans sélection préalable", async () => {
    const f = await start();
    f.advance(); f.state.envelope.worktrees![0]!.agents![0]!.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reason).toBe("no_context");
    await f.presented(f.announcements[0]!.key!, "voice", "display-scheduled");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reason).toBe("no_context");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta("chat"))).reason).toBe("no_context");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta("voice", "another"))).reason).toBe("no_context");
    expect(f.tracking.snapshot().diagnostics?.some((e) => e.stage === "announcement.completed")).toBe(false);
    expect(raw(await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta())).agent.label).toBe("Filtrage mails");
  });

  it("une rafale de bulles garde groupe, ordre, focus et expiration de chaque origine", async () => {
    const f = await start();
    const listed = raw(await f.k.tools.call("orca_agents", { limit: 2 }, meta())).references;
    expect(listed).toHaveLength(2);
    await f.k.tools.call("orca_detail", { id: listed[0].identity }, meta());
    await f.k.tools.call("orca_detail", { name: "Réveil avatar" }, meta("chat"));
    const unrelated = agent("Autre mission");
    f.state.envelope.worktrees![0]!.agents!.push(unrelated);
    f.advance(); await f.tracking.refresh();
    f.advance(); unrelated.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    const key = f.announcements[0]!.key!;
    for (let n = 0; n < 20; n++) {
      await f.presented(key, "voice", "display-scheduled");
      await f.presented(key, "chat", "display-scheduled");
    }
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reference.identity).toBe(listed[0].identity);
    expect(raw(await f.k.tools.call("orca_detail", { name: "le deuxième" }, meta())).reference.identity).toBe(listed[1].identity);
    expect(raw(await f.k.tools.call("orca_detail", {}, meta("chat"))).agent.label).toBe("Réveil avatar");
    f.advance(29 * 60_000);
    await f.presented(key, "voice", "display-scheduled");
    await f.presented(key, "chat", "display-scheduled");
    f.advance(2 * 60_000);
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reason).toBe("expired");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta("chat"))).reason).toBe("expired");
  });

  it("24 h de vrais heartbeats HTTP préservent la chaîne et bornent l'audit", async () => {
    let time = NOW;
    const home = mkdtempSync(join(tmpdir(), "orca-heartbeat-"));
    const audit: Record<string, any>[] = [];
    const ctx = { home, alive: true, audit: { write(e: Record<string, any>) { audit.push(structuredClone(e)); } }, timeout() {}, hook() {}, effect() {} } as unknown as Context;
    const runtime = createOrcaRuntime({ ctx, cli: async () => ({}), run: async () => [], now: () => time, onChanges() {} });
    const stop = await startBridge(home, runtime.acceptBridge, () => {}, { now: () => time, diagnostic: runtime.bridgeDiagnostic });
    try {
      const info = JSON.parse(readFileSync(join(home, "orca-bridge.json"), "utf8"));
      const post = async (event: Record<string, unknown>) => (await fetch(`http://127.0.0.1:${info.port}/orca`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify(event) })).status;
      let sequence = 0;
      const envelope = (event: Record<string, unknown>) => ({ bridgeId: "bridge-a", eventId: `event-${++sequence}`, sequence, sentAt: time, ...event });
      const observed = (state: string) => envelope({ kind: "agent", workspaceId: "w", paneKey: "p", title: "Mission", state, receivedAt: time });
      expect(await post(observed("working"))).toBe(204);
      time++;
      expect(await post(observed("done"))).toBe(204);
      const record = runtime.snapshot().agents[0]!;
      const eventId = runtime.snapshot().events.at(-1)!.eventId;
      runtime.diagnostics.record("announcement.scheduled", { eventId, agentId: record.id });
      runtime.appendDelivery({ agentId: record.id, correlationId: "call-send", delivery: "accepted" });
      const before = audit.length;
      let lastHeartbeat!: Record<string, unknown>;
      for (let n = 0; n < 24 * 60; n++) {
        time += 60_000;
        lastHeartbeat = envelope({ kind: "heartbeat" });
        expect(await post(lastHeartbeat)).toBe(204);
      }
      expect(audit.length - before).toBe(2);
      const traces = runtime.diagnostics.recent(100);
      expect(traces).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "activity.accepted", reason: "transition", eventId }),
        expect.objectContaining({ stage: "announcement.scheduled", eventId }),
        expect.objectContaining({ stage: "activity.accepted", reason: "delivery" }),
        expect.objectContaining({ stage: "bridge.transport", reason: "heartbeat_accepted", count: 1440 }),
        expect.objectContaining({ stage: "bridge.liveness", reason: "heartbeat", count: 1440 }),
      ]));
      expect(await post(lastHeartbeat)).toBe(204);
      expect(await post(envelope({ kind: "heartbeat", sentAt: time - 180_000 }))).toBe(204);
      expect(await post(envelope({ kind: "invalid" }))).toBe(400);
      expect(await post(observed("working"))).toBe(204);
      expect(await post(envelope({ kind: "hello" }))).toBe(204);
      expect(audit.slice(before).filter((e) => e.stage === "bridge.transport").map((e) => e.reason)).toEqual(["heartbeat_accepted", "dedupe_event", "drop_expired", "invalid_schema", "accepted", "accepted"]);
      expect(runtime.diagnostics.recent(100).filter((e) => e.stage === "bridge.transport").map((e) => e.reason)).toEqual(expect.arrayContaining(["dedupe_event", "drop_expired", "invalid_schema", "accepted"]));
    } finally { await stop(); }
  }, 15_000);

  it("conserve les ordinaux et le titre courant dans les accords", async () => {
    const f = await start();
    const list = await f.k.tools.call("orca_agents", {}, meta());
    const position = raw(list).references.findIndex((r: any) => r.label === "Filtrage mails");
    const firstId = raw(list).references[position].identity;
    const a = f.state.envelope.worktrees![0]!.agents![0]!;
    f.advance(); a.taskTitle = "Nouvelle mission"; a.state = "done";
    await f.tracking.refresh();
    const detail = await f.k.tools.call("orca_detail", { name: String(position + 1) }, meta());
    expect(raw(detail).reference).toMatchObject({ identity: firstId, label: "Nouvelle mission" });
    const approvals: string[] = [];
    f.k.bus.on("approval.request", (r) => { approvals.push(r.summary); f.k.approvals.respond(r.id, false, "test"); });
    await f.k.tools.call("orca_send_group", { name: "lui", message: "Relisez le travail" }, meta());
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("Nouvelle mission");
    expect(approvals[0]).not.toContain("Filtrage mails");
    expect(f.calls.some((a) => a[1] === "send")).toBe(false);
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    f.advance(); a.taskTitle = "Mission suivante";
    await f.tracking.refresh();
    expect(f.tracking.snapshot().agents.find((r) => r.id === firstId)?.label).toBe("Mission suivante");
    expect(f.announcements).toHaveLength(1);
  });

  it("une interruption retire seulement le focus encore détenu par cette annonce", async () => {
    const f = await start();
    f.advance(); f.state.envelope.worktrees![0]!.agents![0]!.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    const key = f.announcements[0]!.key!;
    await f.presented(key);
    await f.presented(key, "chat", "interrupted");
    await f.presented(key, "voice", "interrupted");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reason).toBe("no_context");
    expect(raw(await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta())).agent.label).toBe("Filtrage mails");
    await f.presented(key);
    await f.k.tools.call("orca_detail", { name: "Réveil avatar" }, meta());
    await f.presented(key, "voice", "interrupted");
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).agent.label).toBe("Réveil avatar");
  });

  it("les polls inchangés préservent la trace et bornent les écritures d'audit", async () => {
    const f = await start();
    await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    const before = f.k.audit.tail(1000).filter((e) => e.kind === "orca").length;
    for (let n = 0; n < 100; n++) { f.advance(); await f.tracking.refresh(); }
    expect(f.k.audit.tail(1000).filter((e) => e.kind === "orca").length - before).toBeLessThanOrEqual(1);
    expect(f.tracking.snapshot().diagnostics?.some((e) => e.stage === "reference.name")).toBe(true);
  });

  it("conserve l'identité de runtime de l'enveloppe réelle et les autres réponses inchangées", () => {
    const reply = { ok: true, _meta: { runtimeId: "runtime-real" }, result: { worktrees: [], hostScope: { hostIds: ["local"], omittedHostIds: [] } } };
    expect(cliResult(reply, ["worktree", "ps"])).toMatchObject({ runtimeId: "runtime-real", hostScope: reply.result.hostScope });
    expect(cliResult(reply, ["terminal", "list"])).toBe(reply.result);
  });
  it("liste chaque agent du même projet avec des références stables et des pages bornées", async () => {
    const f = await start();
    f.state.envelope.worktrees = [worktree(...Array.from({ length: 25 }, (_, i) => agent(`Mission ${String(i).padStart(2, "0")} ${"x".repeat(150)}`)))];
    const first = await f.k.tools.call("orca_agents", { limit: 10 }, meta());
    expect(first.status).toBe("done");
    expect(first.text.length).toBeLessThanOrEqual(1500);
    expect(raw(first).agents.length).toBeGreaterThan(0);
    expect(raw(first).nextOffset).toBeGreaterThan(0);
    const second = await f.k.tools.call("orca_agents", { offset: raw(first).nextOffset, limit: 10 }, meta());
    expect(raw(second).references[0].identity).not.toBe(raw(first).references[0].identity);
    expect(new Set(raw(first).references.map((r: any) => r.identity)).size).toBe(raw(first).references.length);
  });

  it("filtre par projet, état et date sans transformer une fin inconnue en réussite", async () => {
    const f = await start();
    f.state.envelope.worktrees = [worktree(agent("Filtrage mails", "done"), agent("Réveil avatar", "waiting"))];
    const list = await f.k.tools.call("orca_agents", { project: "Floppy", filter: "finished", since: "2026-11-08T11:00:00Z" }, meta());
    expect(list.text).toContain("Filtrage mails");
    expect(list.text).not.toContain("Réveil avatar");
    expect(list.text).toContain("résultat inconnu");
    expect(raw(list).agents[0].outcome).toBe("unknown");
  });

  it("résout noms, ids, ordinaux et pronoms par corps/session et garde le groupe ordonné", async () => {
    const f = await start();
    const list = await f.k.tools.call("orca_agents", {}, meta());
    const refs = raw(list).references;
    const second = await f.k.tools.call("orca_detail", { name: "le deuxième" }, meta());
    expect(raw(second).reference.identity).toBe(refs[1].identity);
    const follow = await f.k.tools.call("orca_detail", {}, meta());
    expect(raw(follow).reference.identity).toBe(refs[1].identity);
    expect((await f.k.tools.call("orca_detail", {}, meta("chat"))).status).toBe("failed");
    expect((await f.k.tools.call("orca_detail", {}, meta("voice", "new-session"))).status).toBe("failed");
    const first = await f.k.tools.call("orca_detail", { name: "1st" }, meta());
    expect(raw(first).reference.identity).toBe(refs[0].identity);
    expect(raw(await f.k.tools.call("orca_detail", { id: refs[2].identity }, meta())).reference.identity).toBe(refs[2].identity);
    expect((await f.k.tools.call("orca_detail", { name: "Floppy" }, meta())).status).toBe("failed");
  });

  it("une annonce silencieuse ne recible jamais un agent discuté", async () => {
    const f = await start();
    await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    f.advance();
    f.state.envelope.worktrees![0]!.agents![1]!.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    const detail = await f.k.tools.call("orca_detail", {}, meta());
    expect(raw(detail).agent.label).toBe("Filtrage mails");
    expect((await f.k.tools.call("orca_detail", {}, meta("chat"))).status).toBe("failed");
  });

  it("seule la programmation vocale établit une référence dans son origine", async () => {
    const f = await start();
    f.advance(); f.state.envelope.worktrees![0]!.agents![0]!.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    expect((await f.k.tools.call("orca_detail", {}, meta())).status).toBe("failed");
    await f.presented(f.announcements[0]!.key!);
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).agent.label).toBe("Filtrage mails");
    expect((await f.k.tools.call("orca_detail", {}, meta("chat"))).status).toBe("failed");
    const diagnostics = raw(await f.k.tools.call("orca_diagnostic", {})).trace;
    expect(diagnostics.some((event: any) => event.stage === "announcement.scheduled")).toBe(true);
    expect(diagnostics.some((event: any) => event.stage === "announcement.completed")).toBe(false);
  });

  it("annonce deux tours terminés distincts même si le texte reste identique", async () => {
    const f = await start();
    const a = f.state.envelope.worktrees![0]!.agents![0]!;
    f.advance(); a.state = "done"; await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    f.advance(); a.state = "working"; a.stateStartedAt = NOW + 20; await f.tracking.refresh();
    f.advance(); a.state = "done"; await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(2));
    expect(f.announcements[0]!.key).not.toBe(f.announcements[1]!.key);
    expect(f.announcements[0]!.text).toBe(f.announcements[1]!.text);
  });

  it("une annonce trop ancienne ne laisse jamais lui viser le focus précédent", async () => {
    const f = await start();
    await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    f.advance(); f.state.envelope.worktrees![0]!.agents![1]!.state = "done";
    await f.tracking.refresh();
    await vi.waitFor(() => expect(f.announcements).toHaveLength(1));
    f.advance(11 * 60_000);
    await f.presented(f.announcements[0]!.key!);
    expect((await f.k.tools.call("orca_detail", {}, meta())).status).toBe("failed");
  });

  it("agent disparu et référence expirée échouent sans repli vers celui qui attend", async () => {
    const f = await start();
    await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    f.advance(); f.state.envelope.worktrees![0]!.agents!.shift();
    const missing = await f.k.tools.call("orca_detail", {}, meta());
    expect(raw(missing).reason).toBe("missing");
    f.advance(31 * 60_000);
    expect(raw(await f.k.tools.call("orca_detail", {}, meta())).reason).toBe("expired");
  });

  it("un relevé partiel ou une panne ne prouvent pas la disparition", async () => {
    const f = await start();
    const before = f.tracking.snapshot().agents;
    f.advance(); f.state.envelope = { worktrees: [worktree(agent("Filtrage mails"))], truncated: true, totalCount: 3, hostScope: { coveredHosts: ["local"], notCoveredHosts: ["remote"] }, runtimeId: "runtime-a" };
    await f.tracking.refresh();
    expect(f.tracking.snapshot().agents).toHaveLength(3);
    expect(f.tracking.snapshot().agents.every((r) => r.presence !== "absent")).toBe(true);
    const list = await f.k.tools.call("orca_agents", {}, meta());
    expect(raw(list).scope).toMatchObject({ truncated: true, totalCount: 3, runtimeId: "runtime-a" });
    expect(list.text).toContain("partiel");
    f.state.offline = true;
    const stale = await f.k.tools.call("orca_agents", {}, meta());
    expect(raw(stale).connection).toMatchObject({ state: "offline", coverage: "outage" });
    expect(raw(stale).agents).toHaveLength(before.length);
    expect(stale.text).toContain("dernières observations");
  });

  it("reconnaît hostIds/omittedHostIds de la CLI installée sans inventer une absence", async () => {
    const f = await start();
    f.state.envelope = { worktrees: [worktree(agent("Filtrage mails"))], hostScope: { hostIds: ["local"], omittedHostIds: ["paired-server"] } };
    await f.tracking.refresh();
    expect(f.tracking.snapshot().connection.coverage).toBe("partial");
    expect(f.tracking.snapshot().agents.every((r) => r.presence !== "absent")).toBe(true);
    f.state.envelope.hostScope = { hostIds: ["local"], omittedHostIds: [] };
    f.advance(); await f.tracking.refresh();
    expect(f.tracking.snapshot().connection.coverage).toBe("full");
    expect(f.tracking.snapshot().agents.filter((r) => r.presence === "absent")).toHaveLength(2);
  });

  it("nomme aussi les agents sortis du relevé dans les récapitulatifs historiques", async () => {
    const f = await start();
    f.advance(); f.state.envelope.worktrees = [];
    await f.tracking.refresh();
    const history = await f.k.tools.call("orca_history", { name: "Filtrage mails" }, meta());
    expect(f.k.tools.list().map((t) => t.name).filter((n) => ["orca_historique", "orca_ecran", "orca_envoyer_groupe"].includes(n))).toEqual([]); // les anciens noms français n'existent plus
    expect(history.status).toBe("done");
    expect(history.text).toContain("Filtrage mails");
    expect((await f.k.tools.call("orca_detail", {}, meta())).status).toBe("failed");
  });

  it("les détails distinguent mission, provenance, résultat, présence et fraîcheur", async () => {
    const f = await start();
    Object.assign(f.state.envelope.worktrees![0]!.agents![0]!, { state: "done", mainAgent: { state: "done", outcome: "failure" }, prompt: "Filtrer les courriers", lastAssistantMessage: "Les tests échouent", hasLivePty: false });
    f.advance();
    const detail = await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    expect(detail.status).toBe("failed");
    const records = f.tracking.snapshot().agents;
    expect(records.find((r) => r.label === "Filtrage mails")).toMatchObject({ outcome: "failure", presence: "absent" });
    Object.assign(f.state.envelope.worktrees![0]!.agents![0]!, { hasLivePty: true }); f.advance();
    const available = await f.k.tools.call("orca_detail", { name: "Filtrage mails" }, meta());
    expect(available.text).toContain("Filtrer les courriers");
    expect(available.text).toContain("échec");
    expect(available.text).toContain("cli");
    expect(available.text).toContain("Les tests échouent");
    expect(raw(available).agent.outcome).toBe("failure");
    const record = f.tracking.snapshot().agents.find((r) => r.label === "Filtrage mails");
    expect(record).toMatchObject({ mission: "Filtrer les courriers", declaredResult: "Les tests échouent" });
    expect(record).not.toHaveProperty("progress");
  });

  it("l'historique persiste au redémarrage sans notification ni focus automatiques", async () => {
    const f = await start();
    f.advance(); f.state.envelope.worktrees![0]!.agents![0]!.state = "done";
    await f.tracking.refresh();
    await f.k.stopAll();
    const next = await start({ home: f.home });
    const history = await next.k.tools.call("orca_history", { project: "Floppy" }, meta());
    expect(history.text).toContain("Filtrage mails");
    expect(history.text).toContain("Réveil avatar");
    expect(raw(history).events.some((e: any) => e.activity === "finished")).toBe(true);
    expect(next.announcements).toHaveLength(0);
    expect((await next.k.tools.call("orca_detail", {}, meta())).status).toBe("failed");
  });

  it("un écran ne se rabat jamais sur le terminal d'un autre agent du même projet", async () => {
    const f = await start();
    const wrong = await f.k.tools.call("orca_screen", { name: "Réveil avatar" }, meta());
    expect(wrong.status).toBe("failed");
    expect(f.calls.some((args) => args[1] === "read")).toBe(false);
    const right = await f.k.tools.call("orca_screen", { name: "Filtrage mails" }, meta());
    expect(right.text).toContain("Question exacte");
  });

  it("un groupe présenté disparu échoue avant accord, sans agrandir la sélection", async () => {
    const f = await start({ config: { notifications: "none" } });
    for (const a of f.state.envelope.worktrees![0]!.agents!) a.state = "done";
    await f.k.tools.call("orca_agents", {}, meta());
    f.advance(); f.state.envelope.worktrees![0]!.agents!.shift();
    f.state.envelope.worktrees![0]!.agents!.push({ ...agent("Filtrage mails", "done"), paneKey: "tab:replacement" });
    const approvals = vi.fn(); f.k.bus.on("approval.request", approvals);
    const result = await f.k.tools.call("orca_send_group", { name: "eux", filter: "finished", message: "Faites le commit" }, meta());
    expect(result.status).toBe("failed");
    expect(approvals).not.toHaveBeenCalled();
    expect(f.calls.some((args) => args[1] === "send")).toBe(false);
  });

  it("recherche avec filtres CLI vérifiés et préserve les lacunes et le curseur", async () => {
    const f = await start();
    const result = await f.k.tools.call("orca_search", { text: "private-query-token", path: "C:/Notes", since: "2026-11-08T00:00:00Z", agent: "codex", cursor: "opaque" }, meta());
    expect(f.calls).toContainEqual(["search", "--query", "private-query-token", "--scope", "conversation", "--limit", "5", "--path", "C:/Notes", "--agent", "codex", "--since", "2026-11-08T00:00:00Z", "--cursor", "opaque"]);
    expect(result.text).toContain("partielle");
    expect(raw(result).nextCursor).toBe("opaque-cursor");
    const audit = JSON.stringify(f.k.audit.tail(100));
    expect(audit).not.toContain("private-query-token");
    expect(audit).not.toContain("C:/Notes");
  });

  it("diagnostics privés, bornés et corrélés à l'appel sans prompt ni chemin", async () => {
    const f = await start();
    f.state.offline = true;
    await f.k.tools.call("orca_agents", { project: "private-project-token" }, { ...meta(), turn: "turn-a" });
    const result = await f.k.tools.call("orca_diagnostic", {});
    const serialized = JSON.stringify(raw(result));
    expect(serialized).not.toMatch(/private|prompt-token|secret/);
    expect(raw(result).trace.length).toBeLessThanOrEqual(100);
    expect(raw(result).trace.some((e: any) => e.stage === "query.list" && e.turn === "turn-a" && typeof e.callId === "string")).toBe(true);
    expect(result.text).toContain("ne prouve pas");
  });

  it("rien coupe les annonces, conserve la collecte et éteindre retire le service", async () => {
    const f = await start({ config: { notifications: "none", pollSeconds: 0.02 } });
    const seen = vi.fn(); const off = f.tracking.subscribe(seen);
    const before = f.calls.length;
    f.advance(); f.state.envelope.worktrees![0]!.agents![0]!.state = "done";
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(before + 1));
    expect(f.tracking.snapshot().agents.some((r) => r.activity === "finished")).toBe(true);
    expect(seen).toHaveBeenCalled(); expect(f.announcements).toHaveLength(0); off();
    await f.k.stopAll(); const count = f.calls.length;
    await expect(f.tracking.refresh()).rejects.toThrow("orca_stopped");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.calls).toHaveLength(count);
  });

  it("le pont acquitte sans attendre la synthèse et un vieux poll ne remplace pas le push", async () => {
    const f = await start({ options: { bridge: true, phrase: () => new Promise(() => {}) } });
    await vi.waitFor(() => expect(existsSync(join(f.home, "orca-bridge.json"))).toBe(true));
    const info = JSON.parse(readFileSync(join(f.home, "orca-bridge.json"), "utf8"));
    f.advance();
    const response = await fetch(`http://127.0.0.1:${info.port}/orca`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ kind: "agent", workspaceId: "workspace", paneKey: "tab:Filtrage mails", state: "done", mainAgent: { state: "done", outcome: "failure", stateStartedAt: NOW + 5 }, eventId: "event-push", bridgeId: "bridge-a", sequence: 1, sentAt: NOW + 5, receivedAt: NOW + 5 }) });
    expect(response.status).toBe(204);
    expect(f.tracking.snapshot().agents.find((r) => r.label === "Filtrage mails")).toMatchObject({ activity: "finished", outcome: "failure" });
    f.advance(); await f.tracking.refresh();
    expect(f.tracking.snapshot().agents.find((r) => r.label === "Filtrage mails")).toMatchObject({ activity: "finished", outcome: "failure" });
    expect(f.announcements).toHaveLength(0);
  });
});
