import { describe, expect, it } from "vitest";
import { createOrcaDiagnostics } from "../src/diagnostics.ts";

describe("diagnostics Orca bornés", () => {
  it("limite la rétention et la taille de la trace sans enregistrer de paramètres libres", () => {
    let now = 100;
    const audit: unknown[] = [];
    const diagnostics = createOrcaDiagnostics({ audit: { write: (entry) => audit.push(entry), tail: () => [] } }, () => now);
    for (let n = 0; n < 350; n++) diagnostics.record("delivery.transition", { count: n });
    expect(diagnostics.recent(1000)).toHaveLength(100);
    expect(diagnostics.recent(1000)[0]!.count).toBe(250);
    expect(diagnostics.recent(2).map((e) => e.count)).toEqual([348, 349]);
    now += 49 * 3600_000;
    expect(diagnostics.recent()).toEqual([]);
    diagnostics.record("reference.name", { selectedIds: ["agent-a"], prompt: "private-secret", path: "C:/private", message: "private message" } as any, { callId: "call-a", session: "session-a", turn: "turn-a" });
    expect(diagnostics.recent()[0]).toMatchObject({ callId: "call-a", session: "session-a", turn: "turn-a", selectedIds: ["agent-a"] });
    expect(JSON.stringify(audit)).not.toMatch(/private|prompt|message|path/);
  });

  it("borne les chaînes, listes et nombres de métadonnées", () => {
    const diagnostics = createOrcaDiagnostics({ audit: { write() {}, tail: () => [] } });
    diagnostics.record("x".repeat(200), { reason: "x".repeat(400), selectedIds: Array.from({ length: 100 }, () => "x".repeat(200)), latencyMs: -10, contextAgeMs: null, count: Infinity });
    const last = diagnostics.recent()[0]!;
    expect(last.stage).toHaveLength(80);
    expect(last.reason).toHaveLength(160);
    expect(last.selectedIds).toHaveLength(64);
    expect(last.selectedIds![0]).toHaveLength(80);
    expect(last.latencyMs).toBe(0);
    expect(last.contextAgeMs).toBeNull();
    expect(last.count).toBeUndefined();
  });

  it("agrège les polls inchangés sans évincer les décisions ni multiplier l'audit", () => {
    const audit: unknown[] = [];
    const diagnostics = createOrcaDiagnostics({ audit: { write: (e) => audit.push(e), tail: () => [] } });
    diagnostics.record("announcement.scheduled", { eventId: "event-1" });
    diagnostics.record("reference.focus", { selectedIds: ["agent-1"] });
    diagnostics.record("delivery.accepted", { agentId: "agent-1" });
    for (let n = 0; n < 1000; n++) {
      diagnostics.record("poll.started");
      for (let a = 0; a < 10; a++) diagnostics.record("activity.duplicate", { reason: "same_observation", agentId: `agent-${a}` });
      diagnostics.record("poll.completed", { reason: "full", count: 10 });
    }
    expect(audit).toHaveLength(6);
    expect(diagnostics.recent().map((e) => e.stage)).toEqual(expect.arrayContaining(["announcement.scheduled", "reference.focus", "delivery.accepted"]));
    expect(diagnostics.recent().find((e) => e.stage === "activity.duplicate")?.count).toBe(10000);
    diagnostics.record("activity.stale", { reason: "older_observation" });
    diagnostics.record("bridge.transport", { reason: "drop_capacity" });
    diagnostics.record("poll.failed", { reason: "cli_unavailable" });
    expect(audit).toHaveLength(9);
  });
});
