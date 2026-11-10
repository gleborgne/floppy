import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import activate, { createDeliveryQueue, deactivate, readBridgeInfo, type AgentEvent, type BridgeInfo, type WorkerDiagnostic } from "../orca-plugin/src/worker.ts";
import { kindOfEvent, startBridge, validBridgeEvent, type BridgeDiagnostic, type BridgeEvent, type BridgeOptions } from "../src/bridge.ts";

const NOW = 1_800_000_000_000;
const info: BridgeInfo = { port: 1234, token: "secret-token" };
const response = (ok: boolean) => ({ ok, status: ok ? 204 : 503 }) as Response;
const observation = (state = "working", started = NOW, receivedAt = NOW) => ({
  kind: "agent", workspaceId: "w", paneKey: "p", state, receivedAt,
  mainAgent: { state, stateStartedAt: started },
});
const envelope = (sequence = 1, extra: Record<string, unknown> = {}) => ({
  ...observation(), bridgeId: "worker-1", eventId: `worker-1:${sequence}`, sequence, sentAt: NOW, ...extra,
});
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  deactivate();
  for (const stop of cleanups.splice(0)) await stop();
  vi.useRealTimers();
});

describe("livraison bornée du worker", () => {
  it("réessaie après une panne avec le même id, puis conserve les cycles rapides", async () => {
    vi.useFakeTimers();
    let up = false;
    const posted: Record<string, unknown>[] = [];
    const diagnostics: WorkerDiagnostic[] = [];
    const queue = createDeliveryQueue({ now: () => NOW, bridgeId: "b", readInfo: () => info, backoffMs: 10,
      diagnostic: (d) => diagnostics.push(d),
      fetchImpl: (async (_url, init) => { posted.push(JSON.parse(String(init?.body))); return response(up); }) as typeof fetch,
    });
    cleanups.push(() => queue.stop());
    const first = queue.enqueue(observation());
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.size).toBe(1);
    const done = queue.enqueue(observation("done", NOW + 1));
    const working = queue.enqueue(observation("working", NOW + 2));
    const doneAgain = queue.enqueue(observation("done", NOW + 3));
    up = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all([first, done, working, doneAgain])).toEqual([true, true, true, true]);
    expect(posted.slice(0, 2).map((e) => e.eventId)).toEqual(["b:1", "b:1"]);
    expect(posted.map((e) => e.state)).toEqual(["working", "working", "done", "working", "done"]);
    expect(diagnostics.map((d) => d.reason)).toEqual(expect.arrayContaining(["delivery_failed", "retry_scheduled", "delivery_recovered"]));
    expect(diagnostics.find((d) => d.reason === "delivery_recovered")).toMatchObject({ bridgeId: "b", eventId: "b:1", sourceLatencyMs: 0 });
    expect(JSON.stringify(diagnostics)).not.toContain(info.token);
  });

  it("déduplique la même transition mais distingue deux débuts de tour", async () => {
    const fetchImpl = vi.fn(async () => response(true));
    const diagnostics: WorkerDiagnostic[] = [];
    const queue = createDeliveryQueue({ now: () => NOW, readInfo: () => info, fetchImpl, diagnostic: (d) => diagnostics.push(d) });
    cleanups.push(() => queue.stop());
    expect(await queue.enqueue(observation("done", NOW - 2))).toBe(true);
    expect(await queue.enqueue(observation("done", NOW - 2, NOW + 1))).toBe(false);
    expect(await queue.enqueue(observation("done", NOW - 1, NOW + 2))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics.find((d) => d.reason === "dedupe_source")).toMatchObject({ eventId: expect.any(String), bridgeId: expect.any(String) });
  });

  it("borne capacité, âge et nombre d'essais, puis libère toutes les minuteries", async () => {
    vi.useFakeTimers();
    let now = NOW;
    const diagnostics: WorkerDiagnostic[] = [];
    const queue = createDeliveryQueue({ now: () => now, readInfo: () => info, maxQueue: 2, maxAgeMs: 20,
      maxAttempts: 2, backoffMs: 10, fetchImpl: vi.fn(async () => response(false)), diagnostic: (d) => diagnostics.push(d),
    });
    cleanups.push(() => queue.stop());
    const first = queue.enqueue(observation());
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.enqueue(observation("done", NOW + 1));
    const third = queue.enqueue(observation("working", NOW + 2));
    expect(queue.size).toBe(2);
    expect(await first).toBe(false);
    now += 30;
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all([second, third])).toEqual([false, false]);
    expect(diagnostics.map((d) => d.reason)).toEqual(expect.arrayContaining(["drop_capacity", "drop_expired"]));
    now = NOW;
    const attempts = queue.enqueue(observation());
    await vi.advanceTimersByTimeAsync(10);
    expect(await attempts).toBe(false);
    expect(diagnostics.some((d) => d.reason === "drop_attempts")).toBe(true);
    queue.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("annule un transport suspendu à l'arrêt et borne son délai même s'il ignore AbortSignal", async () => {
    vi.useFakeTimers();
    const queue = createDeliveryQueue({ now: () => NOW, readInfo: () => info, requestTimeoutMs: 20, maxAttempts: 1,
      fetchImpl: (() => new Promise(() => {})) as typeof fetch,
    });
    const sent = queue.enqueue(observation());
    await vi.advanceTimersByTimeAsync(20);
    expect(await sent).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const next = queue.enqueue(observation("done"));
    queue.stop();
    expect(await next).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("garde l'envoi actif sous pression, refuse les fichiers invalides et masque les erreurs privées", async () => {
    vi.useFakeTimers();
    let finish!: (r: Response) => void;
    const diagnostics: WorkerDiagnostic[] = [];
    const logs: string[] = [];
    const queue = createDeliveryQueue({ now: () => NOW, readInfo: () => info, maxQueue: 1,
      log: (l) => logs.push(l), diagnostic: (d) => diagnostics.push(d),
      fetchImpl: (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch,
    });
    cleanups.push(() => queue.stop());
    const first = queue.enqueue(observation());
    expect(await queue.enqueue(observation("done"))).toBe(false);
    expect(queue.size).toBe(1);
    finish(response(true));
    expect(await first).toBe(true);
    expect(diagnostics.find((d) => d.reason === "drop_capacity")).toMatchObject({ eventId: expect.any(String) });
    queue.stop();
    const failed = createDeliveryQueue({ now: () => NOW, readInfo: () => info, maxAttempts: 1,
      log: (l) => logs.push(l), fetchImpl: (async () => { throw new Error(`${info.token}: private message content`); }) as typeof fetch,
    });
    expect(await failed.enqueue(observation())).toBe(false);
    failed.stop();
    expect(logs.join(" ")).not.toContain(info.token);
    expect(logs.join(" ")).not.toContain("private message content");
    for (const invalid of ["null", "{}", '{"port":0,"token":"x"}', '{"port":65536,"token":"x"}', '{"port":10,"token":123}']) {
      expect(readBridgeInfo(["/bridge"], () => invalid)).toBe("/bridge : absent");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bonjour et battement ne prétendent pas observer un agent ; deactivate ferme écoute et timers", async () => {
    vi.useFakeTimers();
    const posted: Record<string, unknown>[] = [];
    const dispose = vi.fn();
    let handler: ((e: AgentEvent) => unknown) | undefined;
    activate({ log() {}, events: { on: (_name, h) => { handler = h; return { dispose }; } } }, {
      now: () => NOW, readInfo: () => info, heartbeatMs: 1000,
      fetchImpl: (async (_url, init) => { posted.push(JSON.parse(String(init?.body))); return response(true); }) as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.map((e) => e.kind)).toEqual(["hello", "heartbeat"]);
    expect(posted[1]).not.toHaveProperty("receivedAt");
    await handler!({ workspaceId: "w", paneKey: "p", state: "done", receivedAt: NOW - 10,
      mainAgent: { state: "done", stateStartedAt: NOW - 100, outcome: "unconfirmed" } });
    expect(posted.at(-1)).toMatchObject({ receivedAt: NOW - 10, outcome: "unconfirmed", mainAgent: { stateStartedAt: NOW - 100 } });
    deactivate();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function receiver(onEvent: (e: BridgeEvent) => void | Promise<void>, options: BridgeOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "orca-bridge-fiable-"));
  const stop = await startBridge(home, onEvent, () => {}, { now: () => NOW, ...options });
  cleanups.push(stop);
  const info = JSON.parse(readFileSync(join(home, "orca-bridge.json"), "utf8")) as BridgeInfo;
  const url = `http://127.0.0.1:${info.port}/orca`;
  const headers = { Authorization: `Bearer ${info.token}` };
  return { info, url, headers, stop, post: (body: unknown) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) }) };
}

describe("admission du pont", () => {
  it("acquitte après acceptation, déduplique concurrence et retries, ignore état ancien", async () => {
    const got: BridgeEvent[] = [], diagnostics: BridgeDiagnostic[] = [];
    const r = await receiver((e) => { got.push(e); }, { diagnostic: (d) => diagnostics.push(d) });
    expect((await Promise.all([r.post(envelope()), r.post(envelope())])).map((r) => r.status)).toEqual([204, 204]);
    expect(got).toHaveLength(1);
    await r.post(envelope(3, { state: "done", receivedAt: NOW + 2, outcome: "failure" }));
    await r.post(envelope(2, { receivedAt: NOW + 1 }));
    await r.post(envelope(4, { receivedAt: NOW + 3 }));
    expect(got.map((e) => e.state)).toEqual(["working", "done", "working"]);
    expect(got[1]?.outcome).toBe("failure");
    expect(diagnostics.map((d) => d.reason)).toEqual(expect.arrayContaining(["dedupe_event", "drop_stale", "accepted"]));
    expect(diagnostics.find((d) => d.reason === "accepted")).toMatchObject({ bridgeId: "worker-1", eventId: "worker-1:1", receivedAt: NOW, sourceLatencyMs: 0 });
    expect(JSON.stringify(diagnostics)).not.toContain(r.info.token);
  });

  it("rejoue une admission refusée, sans dédupliquer avant acceptation", async () => {
    let count = 0;
    const r = await receiver(() => { if (++count === 1) throw new Error("secret-content"); });
    expect((await r.post(envelope())).status).toBe(503);
    expect((await r.post(envelope())).status).toBe(204);
    expect((await r.post(envelope())).status).toBe(204);
    expect(count).toBe(2);
  });

  it("garde une admission lente réservée jusqu'à sa fin et borne les requêtes incomplètes", async () => {
    let finish!: () => void;
    const callback = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const r = await receiver(callback, { requestTimeoutMs: 30 });
    expect((await r.post(envelope())).status).toBe(503);
    expect((await r.post(envelope())).status).toBe(503);
    expect(callback).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect((await r.post(envelope())).status).toBe(204);
    expect(callback).toHaveBeenCalledTimes(1);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(r.url, { method: "POST", headers: { ...r.headers, "Content-Length": "100" } }, (res) => {
        resolve(res.statusCode!); res.resume();
      });
      req.on("error", reject); req.write("{");
    });
    expect(status).toBe(408);
    await r.stop();
  });

  it("valide les champs, expire les replays et conserve bonjour historique et outcome brut", async () => {
    const got: BridgeEvent[] = [];
    const r = await receiver((e) => { got.push(e); });
    for (const bad of [null, [], {}, { kind: "other" }, { kind: ["hello"] }, { kind: "heartbeat", state: "done" },
      envelope(1, { state: ["working"] }), envelope(1, { mainAgent: { state: ["done"] } }),
      envelope(1, { receivedAt: "x" }), envelope(1, { receivedAt: 0 }), envelope(1, { sequence: 0 }),
      envelope(1, { state: "invented" }), envelope(1, { paneKey: "x".repeat(2049) }), envelope(1, { mainAgent: { state: "done", outcome: {} } })]) {
      expect((await r.post(bad)).status).toBe(400);
    }
    expect((await r.post(envelope(1, { receivedAt: NOW - 120_001 }))).status).toBe(204);
    expect(got).toHaveLength(0);
    await r.post({ kind: "hello" });
    await r.post({ kind: "agent", workspaceId: "w", paneKey: "p", state: "done", outcome: "future-outcome", privateField: "not forwarded" });
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ outcome: "future-outcome" });
    expect(got[1]).not.toHaveProperty("privateField");
    for (const outcome of [undefined, "failure", "unconfirmed", "unknown", "superseded"]) expect(kindOfEvent("done", outcome)).not.toBe("finished");
    expect(kindOfEvent("done", "success")).toBe("finished");
    expect(validBridgeEvent({ kind: "hello" })).toBe(true);
    expect(validBridgeEvent(envelope(1, { mainAgent: { state: "working", stateStartedAt: -1 } }))).toBe(true);
  });

  it("un nouveau worker n'efface pas une observation plus récente ; les contrôles restent distincts", async () => {
    const got: BridgeEvent[] = [];
    const r = await receiver((e) => { got.push(e); });
    await r.post(envelope(10, { receivedAt: NOW, state: "done", outcome: "success" }));
    await r.post(envelope(1, { bridgeId: "new-worker", receivedAt: NOW - 10 }));
    await r.post({ kind: "hello", bridgeId: "new-worker", eventId: "hello-2", sequence: 2, sentAt: NOW });
    await r.post({ kind: "heartbeat", bridgeId: "new-worker", eventId: "heartbeat-3", sequence: 3, sentAt: NOW });
    await r.post(envelope(4, { bridgeId: "new-worker", receivedAt: NOW + 1 }));
    expect(got.map((e) => e.kind)).toEqual(["agent", "hello", "heartbeat", "agent"]);
    expect(got[1]).not.toHaveProperty("receivedAt");
    expect(got[2]).not.toHaveProperty("state");
  });
});
