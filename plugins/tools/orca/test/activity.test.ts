import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCorruptFile } from "@floppy/core";
import { createActivityStore, activityAgentId, activityObservation, type ActivityDiagnostic, type ActivityObservation, type ActivitySnapshot } from "../src/activity.ts";

const START = 1_800_000_000_000;
const HOUR = 3600000;
const identity = { hostId: "host", workspaceId: "workspace", agentId: "pane", incarnation: "session" };
const agent = (extra: Partial<ActivityObservation> = {}): ActivityObservation => ({ identity, project: "Floppy", label: "Mail filtering", state: "working", presence: "live", ...extra });
const snapshot = (agents: ActivityObservation[], extra: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({ hostId: "host", source: "poll", coverage: "full", agents, ...extra });
function setup(extra: Parameters<typeof createActivityStore>[0] = {}) {
  let time = START;
  const diagnostics: ActivityDiagnostic[] = [];
  const store = createActivityStore({ now: () => time, diagnostics: (d) => diagnostics.push(d), ...extra });
  return { store, diagnostics, tick: (ms = 1) => { time += ms; }, set: (at: number) => { time = at; } };
}

describe("activité Orca bornée", () => {
  it("actualise le titre sans changer l'identité ni annoncer une nouvelle fin", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent({ label: undefined, state: "done", eventId: "bridge-1" })]));
    const id = store.current()[0]!.id;
    expect(store.current()[0]!.label).not.toContain(identity.agentId);
    tick();
    expect(store.ingest(snapshot([agent({ label: "codex", state: "done" })]))).toEqual([]);
    tick();
    const renamed = store.ingest(snapshot([agent({ label: "Fix login", state: "done", eventId: "bridge-1" })]));
    expect(renamed).toMatchObject([{ kind: "observation", label: "Fix login", id }]);
    tick();
    store.ingest(snapshot([agent({ label: "New mission", state: "done" })]));
    expect(store.current()[0]).toMatchObject({ id, label: "New mission" });
    tick(); store.ingest(snapshot([agent({ label: undefined, state: "done" })]));
    expect(store.current()[0]!.label).toBe("New mission");
    expect(store.query().filter((e) => e.kind === "transition")).toEqual([]);
  });

  it("distingue les titres actualisés sans UUID dans les noms", () => {
    const { store, tick } = setup();
    const other = { ...identity, agentId: "pane2" };
    store.ingest(snapshot([agent({ label: "codex" }), agent({ identity: other, label: "codex" })]));
    tick(); store.ingest(snapshot([agent(), agent({ identity: other })]));
    expect(new Set(store.current().map((r) => r.label)).size).toBe(2);
    expect(store.current().every((r) => r.label.startsWith("Mail filtering"))).toBe(true);
  });

  it("retire les identifiants techniques et enrichit le repli sans mission", () => {
    const { store, tick } = setup();
    const uuid = "12345678-1234-1234-1234-123456789abc";
    store.ingest(snapshot([agent({ label: uuid, workspaceLabel: uuid, agentType: "codex" })]));
    expect(store.current()[0]!.label).toBe("Agent codex · Floppy");
    tick(); store.ingest(snapshot([agent({ label: `Fix login ${uuid}` })]));
    expect(store.current()[0]!.label).toBe("Fix login");
  });

  it("sépare baseline, activité, résultat déclaré et présence", () => {
    const { store } = setup();
    const events = store.ingest(snapshot([agent({ state: "done", declaredResult: "Build checked" })]));
    expect(events[0]).toMatchObject({ kind: "baseline", activity: "finished", outcome: "unknown", presence: "live", declaredResult: "Build checked" });
    expect(store.current()[0]?.label).toContain("Mail filtering");
    expect(store.current()[0]?.id).toBe(activityAgentId(identity));
  });

  it("ne transforme jamais une erreur ou un état inconnu en succès", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent({ state: "failed", outcome: "success" })]));
    expect(store.current()[0]?.outcome).toBe("failure");
    tick(); store.ingest(snapshot([agent({ state: "unrecognized" })]));
    expect(store.current()[0]).toMatchObject({ activity: "unknown", outcome: "unknown" });
    tick(); store.ingest(snapshot([agent({ state: "interrupted" })]));
    expect(store.current()[0]?.outcome).toBe("interruption");
    tick(); store.ingest(snapshot([agent({ state: "done", outcome: "success" })]));
    expect(store.current()[0]?.outcome).toBe("success");
  });

  it("ignore les doublons mais garde deux cycles terminés à quelques secondes d'écart", () => {
    const { store, tick, diagnostics } = setup();
    store.ingest(snapshot([agent()]));
    const label = store.current()[0]!.label;
    tick(); expect(store.ingest(snapshot([agent()]))).toEqual([]);
    tick(); store.ingest(snapshot([agent({ state: "done" })]));
    tick(); store.ingest(snapshot([agent({ label: "Other title", state: "working" })]));
    tick(); store.ingest(snapshot([agent({ state: "done" })]));
    const done = store.query().filter((e) => e.activity === "finished");
    expect(done).toHaveLength(2);
    expect(done[0]!.cycleId).not.toBe(done[1]!.cycleId);
    expect(done[0]!.eventId).not.toBe(done[1]!.eventId);
    expect(store.current()[0]!.label).toBe(label);
    expect(diagnostics.some((d) => d.type === "duplicate")).toBe(true);
  });

  it("utilise les cycles et événements sources sans fusionner des fins distinctes", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent({ state: "done", cycleId: "turn1", eventId: "source1" })]));
    tick(); expect(store.ingest(snapshot([agent({ state: "done", cycleId: "turn1", eventId: "source1" })]))).toEqual([]);
    tick(); store.ingest(snapshot([agent({ state: "done", cycleId: "turn2", eventId: "source2" })]));
    expect(store.query().map((e) => e.sourceEventId)).toEqual(["source1", "source2"]);
    expect(store.current()).toHaveLength(1);
  });

  it("refuse les observations désordonnées et contradictions au même instant", () => {
    const { store, tick, diagnostics } = setup();
    store.ingest(snapshot([agent()]));
    tick(100); store.ingest(snapshot([agent({ state: "failed" })]));
    store.ingest(snapshot([agent({ state: "done", observedAt: START + 50 })]));
    store.ingest(snapshot([agent({ state: "done" })]));
    expect(store.current()[0]?.outcome).toBe("failure");
    expect(diagnostics.filter((d) => d.type === "stale")).toHaveLength(2);
  });

  it("distingue même projet, hôte, espace et incarnation, et les noms dupliqués", () => {
    const { store } = setup();
    const other = { ...identity, agentId: "pane2" };
    store.ingest(snapshot([agent(), agent({ identity: other })]));
    const current = store.current();
    expect(new Set(current.map((r) => r.id)).size).toBe(2);
    expect(new Set(current.map((r) => r.label)).size).toBe(2);
    expect(current.every((r) => r.label.startsWith("Mail filtering"))).toBe(true);
    expect(activityAgentId(identity)).not.toBe(activityAgentId({ ...identity, hostId: "other" }));
    expect(activityAgentId(identity)).not.toBe(activityAgentId({ ...identity, workspaceId: "other" }));
    expect(activityAgentId(identity)).not.toBe(activityAgentId({ ...identity, incarnation: "new" }));
  });

  it("ne marque pas absent sur couverture partielle, panne ou agents d'un autre espace", () => {
    const { store, tick, diagnostics } = setup();
    store.ingest(snapshot([agent()]));
    tick(); store.ingest(snapshot([], { coverage: "partial" }));
    tick(); store.ingest(snapshot([], { coverage: "outage" }));
    tick(); store.ingest(snapshot([], { workspaceIds: ["elsewhere"] }));
    expect(store.current()[0]?.presence).toBe("live");
    expect(diagnostics.filter((d) => d.type === "coverage").map((d) => d.reason)).toEqual(["incomplete", "source_outage"]);
    tick(); store.ingest(snapshot([], { workspaceIds: ["workspace"] }));
    expect(store.current()[0]?.presence).toBe("absent");
  });

  it("expire la présence et supprime l'état ancien indépendamment de l'historique", () => {
    const { store, tick, diagnostics } = setup();
    store.ingest(snapshot([agent()]));
    tick(120000); expect(store.current()[0]?.presence).toBe("unknown");
    tick(HOUR); expect(store.current()).toEqual([]);
    expect(store.query()).toHaveLength(1);
    expect(diagnostics.some((d) => d.reason === "current_retention")).toBe(true);
    tick(48 * HOUR); expect(store.query()).toEqual([]);
  });

  it("n'autorise pas une vieille réponse à ressusciter un agent absent supprimé", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent()]));
    tick(10); store.ingest(snapshot([]));
    tick(2 * HOUR); expect(store.current()).toEqual([]);
    expect(store.ingest(snapshot([agent({ observedAt: START })], { observedAt: START }))).toEqual([]);
    expect(store.current()).toEqual([]);
  });

  it("n'entretient pas indéfiniment un agent déclaré mort par les relevés", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent()]));
    tick(); store.ingest(snapshot([agent({ state: "dead" })]));
    expect(store.current()[0]?.presence).toBe("absent");
    tick(2 * HOUR);
    store.ingest(snapshot([agent({ state: "dead" })]));
    expect(store.current()).toEqual([]);
    tick(); store.ingest(snapshot([agent({ state: "working" })]));
    expect(store.current()[0]?.presence).toBe("live");
  });

  it("refuse la couverture complète périmée et conserve les autres hôtes", () => {
    const { store, tick } = setup();
    store.ingest(snapshot([agent()]));
    const elsewhere = agent({ identity: { ...identity, hostId: "remote" } });
    store.ingest(snapshot([elsewhere], { hostId: "remote" }));
    tick(100); store.ingest(snapshot([agent({ state: "done" })]));
    store.ingest(snapshot([], { observedAt: START + 10 }));
    expect(store.current().every((r) => r.presence === "live")).toBe(true);
    tick(); store.ingest(snapshot([]));
    expect(store.current().find((r) => r.identity.hostId === "remote")?.presence).toBe("live");
    expect(store.current().find((r) => r.identity.hostId === "host")?.presence).toBe("absent");
  });

  it("rend les diagnostics d'expiration corrélables et tolère un journal cassé", () => {
    const { store, diagnostics, tick } = setup({ maxEvents: 1 });
    const baseline = store.ingest(snapshot([agent()]))[0]!;
    tick(); store.ingest(snapshot([agent({ state: "done" })]));
    expect(diagnostics.find((d) => d.reason === "event_cap")).toMatchObject({ agentId: baseline.id, eventId: baseline.eventId, observedAt: START });
    tick(48 * HOUR); store.query();
    expect(diagnostics.some((d) => d.reason === "retention" && d.agentId && d.eventId)).toBe(true);
    const broken = setup({ diagnostics: () => { throw new Error("journal"); } });
    expect(() => broken.store.ingest(snapshot([agent()]))).not.toThrow();
  });

  it("garde au plus 500 événements, y compris après redémarrage", () => {
    let saved: unknown;
    const persistence = { read: () => saved, write: (_file: string, value: unknown) => { saved = structuredClone(value); } };
    const { store, tick } = setup({ persistence });
    for (let n = 0; n < 520; n++) { tick(); store.ingest(snapshot([agent({ state: n % 2 ? "done" : "working" })])); }
    expect(store.query()).toHaveLength(500);
    expect(store.persist()).toBe(true);
    expect(createActivityStore({ persistence, now: () => START + 1000 }).query()).toHaveLength(500);
  });

  it("purge à 48h au chargement puis à chaque appel, textes et noms compris", () => {
    let saved: unknown;
    const persistence = { read: () => saved, write: (_file: string, value: unknown) => { saved = structuredClone(value); } };
    const { store } = setup({ persistence });
    store.ingest(snapshot([agent({ declaredResult: "private result" })])); store.persist();
    const later = createActivityStore({ persistence, now: () => START + 48 * HOUR });
    expect(later.query()).toEqual([]); expect(later.current()).toEqual([]);
    later.persist();
    expect(JSON.stringify(saved)).not.toContain("private result");
    expect(JSON.stringify(saved)).not.toContain("Mail filtering");
  });

  it("borne les extraits et garde les diagnostics sans contenu", () => {
    const { store, diagnostics } = setup();
    store.ingest(snapshot([agent({ label: "secret".repeat(100), declaredResult: "secret".repeat(1000), lastAction: "secret".repeat(100) })]));
    expect(store.current()[0]!.declaredResult).toHaveLength(600);
    expect(store.current()[0]!.lastAction).toHaveLength(240);
    expect(store.current()[0]!.label.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    expect(diagnostics[0]).toMatchObject({ type: "accepted", reason: "baseline", at: START, agentId: activityAgentId(identity) });
  });

  it("enregistre une transmission sans inventer un résultat de tâche", () => {
    const { store, diagnostics } = setup();
    store.ingest(snapshot([agent()]));
    const delivery = { agentId: activityAgentId(identity), correlationId: "send1", delivery: "accepted" as const };
    expect(store.appendDelivery(delivery)).toMatchObject({ kind: "delivery", delivery: "accepted", outcome: "unknown", correlationId: "send1" });
    expect(store.appendDelivery(delivery)).toBeUndefined();
    expect(store.current()[0]?.activity).toBe("working");
    expect(diagnostics.some((d) => d.correlationId === "send1" && d.type === "accepted")).toBe(true);
    expect(store.query({ agentId: delivery.agentId, project: "Floppy", since: START, limit: 1 })).toHaveLength(1);
    expect(store.query({ project: "other" })).toEqual([]);
  });

  it("utilise la persistance atomique réelle et met à part le JSON corrompu", () => {
    const home = mkdtempSync(join(tmpdir(), "orca-activity-"));
    const report = vi.fn();
    const old = onCorruptFile(report);
    try {
      writeFileSync(join(home, "orca-activity.json"), "{broken");
      const { store, diagnostics } = setup({ home });
      expect(report).toHaveBeenCalledOnce();
      expect(readdirSync(home).some((f) => f.includes(".corrupt-"))).toBe(true);
      expect(diagnostics.some((d) => d.reason === "corrupt_json")).toBe(true);
      store.ingest(snapshot([agent()])); expect(store.persist()).toBe(true);
      expect(createActivityStore({ home, now: () => START }).query()).toHaveLength(1);
    } finally { onCorruptFile(old); }
  });

  it("signale les erreurs de persistance et refuse d'écraser un schéma invalide", () => {
    const write = vi.fn();
    const { store, diagnostics } = setup({ persistence: { read: () => ({ version: 99 }), write } });
    expect(store.persist()).toBe(false); expect(write).not.toHaveBeenCalled();
    expect(diagnostics.map((d) => d.reason)).toContain("invalid_schema");
    const broken = setup({ persistence: { read: () => undefined, write: () => { throw new Error("secret"); } } });
    expect(broken.store.persist()).toBe(false);
    expect(broken.diagnostics.at(-1)?.reason).toBe("write_failed");
    expect(JSON.stringify(broken.diagnostics)).not.toContain("secret");
  });

  it("adapte les métadonnées Orca sans mettre updatedAt dans l'identité", () => {
    const w = { worktreeId: "workspace", displayName: "Floppy" };
    const a = { paneKey: "pane", taskTitle: "Avatar wakeup", state: "done", stateStartedAt: 123, updatedAt: 456, sessionId: "session" };
    const observation = activityObservation(w, a, { hostId: "host", observedAt: START });
    expect(observation).toMatchObject({ identity, label: "Avatar wakeup", cycleId: "123", observedAt: START });
    expect(activityAgentId(observation.identity)).toBe(activityAgentId(activityObservation(w, { ...a, updatedAt: 999 }, { hostId: "host" }).identity));
  });

  it("garde les labels humains et désambiguïse seulement une collision", () => {
    const { store } = setup();
    store.ingest(snapshot([agent(), agent({ identity: { ...identity, agentId: "pane2" } }), agent({ identity: { ...identity, agentId: "pane3" } })]));
    expect(store.current().map((r) => r.label)).toEqual(["Mail filtering", "Mail filtering (Floppy)", "Mail filtering (2)"]);
  });

  it("privilégie le projet et garde le nom de l'espace comme contexte", () => {
    const w = { worktreeId: "workspace", repo: "Floppy", displayName: "assistant" };
    const observation = activityObservation(w, { paneKey: "pane", taskTitle: "Memory analysis" }, { hostId: "host" });
    expect(observation).toMatchObject({ project: "Floppy", workspaceLabel: "assistant", presence: "unknown" });
    const { store } = setup();
    store.ingest(snapshot([observation]));
    expect(store.current()[0]).toMatchObject({ presence: "unknown", project: "Floppy", workspaceLabel: "assistant" });
  });

  it("exige une preuve de terminal vivant et lit mainAgent.outcome", () => {
    const w = { worktreeId: "workspace" };
    const observation = (extra: Record<string, unknown>) => activityObservation(w, { paneKey: "pane", state: "done", ...extra }, { hostId: "host" });
    expect(observation({})).toMatchObject({ presence: "unknown", outcome: "unknown" });
    expect(observation({ hasLivePty: true, mainAgent: { outcome: "failed" } })).toMatchObject({ presence: "live", outcome: "failure" });
    expect(observation({ hasLivePty: false, mainAgent: { outcome: "unverified" } })).toMatchObject({ presence: "absent", outcome: "unconfirmed" });
    expect(observation({ mainAgent: { outcome: "cancelled" } }).outcome).toBe("interruption");
    expect(observation({ mainAgent: { state: "done", outcome: "cancellation" } }).outcome).toBe("interruption");
    const { store } = setup();
    store.ingest(snapshot([agent({ presence: undefined })]));
    expect(store.current()[0]?.presence).toBe("unknown");
  });
});
