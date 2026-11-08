import { afterEach, expect, it, vi } from "vitest";
import type { AgentTrackingService, AgentTrackingSnapshot } from "@floppy/contracts";
import { boundedTracking, watchTracking } from "../src/tracking-source.ts";

const snapshot = (): AgentTrackingSnapshot => ({ at: Date.now(), agents: [{ id: "agent-a", label: "Camille", project: "Contoso", activity: "working", outcome: "unknown", presence: "live", observedAt: Date.now(), lastSeenAt: Date.now() }], events: [], connection: { state: "connected", lastSyncAt: Date.now(), coverage: "partial" } });
function provider() {
  let notify = () => {};
  const unsubscribe = vi.fn();
  const svc: AgentTrackingService = { snapshot: vi.fn(snapshot), subscribe: vi.fn((fn) => { notify = fn; return unsubscribe; }), refresh: vi.fn(async () => {}) };
  return { svc, unsubscribe, notify: () => notify() };
}
afterEach(() => vi.useRealTimers());

it("suit un fournisseur absent, disponible, arrêté et remplacé sans perdre les derniers faits", () => {
  let svc: AgentTrackingService | undefined;
  let changed!: (name: string) => void;
  const publish = vi.fn(), unwatch = vi.fn();
  const relay = watchTracking({ service: () => svc, changed: (fn) => { changed = fn; return unwatch; }, publish });
  expect(publish.mock.lastCall?.[0]).toMatchObject({ agents: [], connection: { state: "offline", coverage: "outage" } });
  const first = provider(); svc = first.svc; changed("agentTracking");
  expect(first.svc.subscribe).toHaveBeenCalledOnce();
  expect(publish.mock.lastCall?.[0]).toMatchObject({ agents: [{ label: "Camille" }], connection: { coverage: "partial" } });
  first.notify(); expect(publish).toHaveBeenCalledTimes(3);
  changed("coder"); expect(publish).toHaveBeenCalledTimes(3);
  svc = undefined; changed("agentTracking");
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  expect(publish.mock.lastCall?.[0]).toMatchObject({ agents: [{ label: "Camille" }], connection: { state: "offline" } });
  const second = provider(); svc = second.svc; changed("agentTracking");
  expect(publish.mock.lastCall?.[0].connection.state).toBe("connected");
  relay.stop(); second.notify();
  expect(second.unsubscribe).toHaveBeenCalledOnce(); expect(unwatch).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledTimes(5);
});

it("borne et déduplique l'actualisation, annule au remplacement et à l'arrêt", async () => {
  vi.useFakeTimers();
  const first = provider();
  let signal: AbortSignal | undefined;
  first.svc.refresh = vi.fn((s) => { signal = s; return new Promise<void>(() => {}); });
  let svc: AgentTrackingService | undefined = first.svc;
  let changed!: (name: string) => void;
  const relay = watchTracking({ service: () => svc, changed: (fn) => { changed = fn; return () => {}; }, publish() {} });
  const pending = relay.refresh(); expect(relay.refresh()).toBe(pending);
  await Promise.resolve(); expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000); expect(await pending).toBe(false); expect(signal?.aborted).toBe(true);
  const next = relay.refresh(); await Promise.resolve(); svc = undefined; changed("agentTracking");
  expect(await next).toBe(false); expect(signal?.aborted).toBe(true);
  expect(await relay.refresh()).toBe(false);
  svc = first.svc; changed("agentTracking");
  const stopped = relay.refresh(); await Promise.resolve(); relay.stop(); expect(await stopped).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("garde les faits anciens/partiels, traite une panne sans rejeter et retire les champs non autorisés", async () => {
  const p = provider(), publish = vi.fn();
  const relay = watchTracking({ service: () => p.svc, changed: () => () => {}, publish });
  p.svc.snapshot = () => { throw new Error("secret interne"); };
  p.svc.refresh = async () => { throw new Error("secret interne"); };
  expect(await relay.refresh()).toBe(false);
  expect(publish.mock.lastCall?.[0]).toMatchObject({ agents: [{ label: "Camille" }], connection: { state: "stale", coverage: "partial" } });
  expect(JSON.stringify(publish.mock.lastCall)).not.toContain("secret interne");
  relay.stop();
  const s = snapshot();
  Object.assign(s, { prompt: "secret" }); Object.assign(s.agents[0]!, { token: "secret", details: "x".repeat(5000) });
  s.diagnostics = [{ at: 1, reason: "source.partial", component: "orca", correlationId: "call-12" }, { at: 1, reason: "un message secret avec espaces", callId: "C:/private/token" }];
  const bounded = boundedTracking(s);
  expect(bounded).not.toHaveProperty("prompt"); expect(bounded.agents[0]).not.toHaveProperty("token");
  expect(bounded.agents[0]?.details).toHaveLength(4000);
  expect(bounded.diagnostics?.[0]).toMatchObject({ reason: "source.partial", correlationId: "call-12" });
  expect(JSON.stringify(bounded.diagnostics)).not.toMatch(/secret|private/);
});
