// Corps Reachy avec un faux daemon HTTP local (routes : /api/daemon/status, /api/move/goto).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import bodyHub, { type BodyHub } from "@floppy/plugin-body-hub";
import { EMOTIONS } from "@floppy/protocol";
import bodyReachy from "../src/index.ts";
import { EMOTION_GESTURE, GESTURES } from "../src/gestures.ts";
import { capabilitiesFor } from "../src/link.ts";

interface Fake { url: string; gotos: any[]; setStatus(s: object | null): void; close(): Promise<void> }

async function fakeDaemon(): Promise<Fake> {
  let status: object | null = { robot_name: "reachy_mini", state: "running", simulation_enabled: true, no_media: true };
  const gotos: any[] = [];
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/daemon/status" && status) return void res.end(JSON.stringify(status));
      if (req.url === "/api/move/goto" && req.method === "POST") { gotos.push(JSON.parse(body)); return void res.end(JSON.stringify({ uuid: "u" + gotos.length })); }
      res.statusCode = status ? 404 : 503;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, gotos,
    setStatus: (s) => { status = s; },
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error("délai dépassé"); await new Promise((r) => setTimeout(r, 15)); }
};

describe("body-reachy", () => {
  let k: Kernel;
  let fake: Fake;
  let hub: BodyHub;
  const oldHome = process.env.FLOPPY_HOME;

  beforeEach(async () => {
    process.env.FLOPPY_HOME = mkdtempSync(join(tmpdir(), "reachy-"));
    fake = await fakeDaemon();
    k = new Kernel({ logger: () => {}, plugins: [bodyHub, bodyReachy] });
    await k.applyConfig({
      assistant: { name: "Floppy", wake_words: ["floppy"] },
      approvals: { timeout_s: 5 },
      plugins: [
        { id: "body", plugin: "body-hub" },
        { id: "reachy", plugin: "body-reachy", config: { retry_s: 0.1, pace: 0.001 } },
      ],
    });
    hub = k.service<BodyHub>("body")!;
  });
  afterEach(async () => {
    await k.stopAll();
    await fake.close();
    if (oldHome === undefined) delete process.env.FLOPPY_HOME; else process.env.FLOPPY_HOME = oldHome;
  });

  const add = (name = "Bureau") => k.items.run({ op: "add", provider: "reachy", kind: "reachy", values: { name, url: fake.url } }, "ui");

  it("les 28 émotions ont un geste", () => {
    for (const e of EMOTIONS) expect(GESTURES[EMOTION_GESTURE[e]], e).toBeTruthy();
  });

  it("pas de voix sans pont audio, ni en simulation", () => {
    const v = { name: "x", url: "x", mic: "robot" as const, voice: "same", approve: true };
    expect(capabilitiesFor(v, { simulation_enabled: true })).toEqual(["emotion", "gesture", "approval"]);
    expect(capabilitiesFor(v, { simulation_enabled: false, no_media: false }, true)).toContain("voice");
    expect(capabilitiesFor(v, { simulation_enabled: true }, true)).not.toContain("voice");
  });

  it("test : contacte le daemon et renvoie ses capacités", async () => {
    const ok = await k.items.run({ op: "test", provider: "reachy", kind: "reachy", values: { url: fake.url } }, "ui");
    expect(ok.ok).toBe(true);
    expect(ok.children?.map((c) => c.id)).toEqual(["emotion", "gesture", "approval"]);
    const bad = await k.items.run({ op: "test", provider: "reachy", kind: "reachy", values: { url: "http://127.0.0.1:1" } }, "ui");
    expect(bad.ok).toBe(false);
  });

  it("detect : trouve le daemon local seulement s'il répond", async () => {
    const r = await k.items.run({ op: "action", provider: "reachy", id: "_", action: "detect" }, "ui");
    expect(r.ok).toBe(false); // localhost:8000 éteint
  });

  it("ajout : le robot se branche au hub avec ses outils, et le statut passe à branché", async () => {
    const r = await add();
    expect(r.ok).toBe(true);
    await until(() => hub.sessions().length === 1);
    const s = hub.sessions()[0]!;
    expect(s.capabilities).toEqual(["emotion", "gesture", "approval"]);
    expect(s.tools).toEqual(["hocher_tete", "secouer_tete", "regarder", "content", "danser"]);
    const snap = (await k.items.snapshot()).find((p) => p.id === "reachy")!;
    expect(snap.items[0]).toMatchObject({ label: "Bureau", status: "ok", active: true });
  });

  it("émotion → requêtes de mouvement ; outil corps → geste", async () => {
    await add();
    await until(() => hub.sessions().length === 1);
    hub.broadcast({ type: "emotion", emotion: "happy" }, "emotion");
    await until(() => fake.gotos.length >= GESTURES.happy!.length);
    expect(fake.gotos[0]).toMatchObject({ antennas: [expect.closeTo(0.698, 2), expect.closeTo(-0.698, 2)], interpolation: "minjerk" });
    expect(fake.gotos[0].head_pose.z).toBeCloseTo(0.008, 5);
    const n = fake.gotos.length;
    const r = await k.tools.call("regarder", { direction: "gauche" });
    expect(r.status).toBe("done");
    expect(fake.gotos.length).toBe(n + 1);
    expect(fake.gotos.at(-1).head_pose.yaw).toBeCloseTo(0.611, 2);
    const bad = await k.tools.call("regarder", { direction: "ailleurs" });
    expect(bad.status).toBe("failed");
  });

  it("en anglais : réponses des outils du robot dans la langue de l'assistant", async () => {
    await k.settings.change("assistant_language", "en", "ui");
    await k.idle();
    hub = k.service<BodyHub>("body")!;
    await add();
    await until(() => hub.sessions().length === 1);
    const r = await k.tools.call("regarder", { direction: "left" });
    expect(r).toMatchObject({ status: "done", text: "Done." });
    const bad = await k.tools.call("regarder", { direction: "ailleurs" });
    expect(bad.text).toBe("Unknown direction: left, right, up, down or front.");
  });

  it("désactivation : débranché du hub, outils retirés ; réactivation : rebranché", async () => {
    const id = (await add()).id!;
    await until(() => hub.sessions().length === 1);
    expect((await k.items.run({ op: "enable", provider: "reachy", id, on: false }, "ui")).ok).toBe(true);
    expect(hub.sessions()).toHaveLength(0);
    expect(k.tools.list().some((t) => t.name === "danser")).toBe(false);
    const snap = (await k.items.snapshot()).find((p) => p.id === "reachy")!;
    expect(snap.items[0]).toMatchObject({ enabled: false, status: "off" });
    await k.items.run({ op: "enable", provider: "reachy", id, on: true }, "ui");
    await until(() => hub.sessions().length === 1);
    await k.items.run({ op: "remove", provider: "reachy", id }, "ui");
    expect(hub.sessions()).toHaveLength(0);
    expect((await k.items.snapshot()).find((p) => p.id === "reachy")!.items).toHaveLength(0);
  });

  it("injoignable : statut d'erreur, puis branché dès que le daemon revient", async () => {
    fake.setStatus(null);
    await add();
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.sessions()).toHaveLength(0);
    expect((await k.items.snapshot()).find((p) => p.id === "reachy")!.items[0]).toMatchObject({ status: "error", active: false });
    fake.setStatus({ robot_name: "reachy_mini", state: "running" });
    await until(() => hub.sessions().length === 1);
  });

  it("modification à chaud : nouvelle adresse = nouvelle connexion", async () => {
    const id = (await add()).id!;
    await until(() => hub.sessions().length === 1);
    await k.items.run({ op: "update", provider: "reachy", id, values: { name: "Salon", approve: false } }, "ui");
    await until(() => hub.sessions().some((s) => s.name === "Salon"));
    expect(hub.sessions()).toHaveLength(1);
    expect(hub.sessions()[0]!.capabilities).toEqual(["emotion", "gesture"]);
  });
});
