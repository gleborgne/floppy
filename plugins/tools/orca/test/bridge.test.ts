import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createOrcaPlugin, type OrcaWorktree } from "../src/index.ts";
import { kindOfEvent } from "../src/bridge.ts";
import activate, { bridgeFiles, changes, readBridgeInfo, createBridge, type AgentEvent, type BridgeInfo } from "../orca-plugin/src/worker.ts";

// Pont : le plugin Orca « Floppy » prévient Floppy aussitôt qu'un agent change d'état.
const NOW = 1_800_000_000_000;
const WS = "repo::C:/x";
const ag = (paneKey: string, state: string, extra: Record<string, unknown> = {}) => ({ paneKey, state, agentType: "claude", ...extra });
const wt = (agents: unknown[]): OrcaWorktree[] => [{ worktreeId: WS, repo: "differendum", displayName: "differendum", agents } as OrcaWorktree];

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

async function start(data: { v: OrcaWorktree[]; calls: number; fail?: boolean }) {
  const home = mkdtempSync(join(tmpdir(), "orca-pont-"));
  const plugin = createOrcaPlugin({ run: async () => { data.calls++; if (data.fail) throw new Error("hors ligne"); return data.v; }, now: () => NOW, phrase: async () => undefined });
  const k = new Kernel({ logger: () => {}, plugins: [plugin], home });
  kernels.push(k);
  const got: { text: string; key?: string; importance: string }[] = [];
  k.bus.on("initiative", (e) => { got.push(e); });
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 0.02 } }] });
  await vi.waitFor(() => expect(existsSync(join(home, "orca-bridge.json"))).toBe(true));
  await vi.waitFor(() => expect(data.calls).toBeGreaterThan(0));
  const info = JSON.parse(readFileSync(join(home, "orca-bridge.json"), "utf8")) as BridgeInfo;
  return { k, got, home, info };
}

/** Le worker Orca, branché sur ce Floppy, avec un faux Orca qui émet des événements. */
function orcaWorker(info: BridgeInfo, fetchImpl: typeof fetch = fetch) {
  let clock = NOW;
  let handler: ((e: AgentEvent) => unknown) | undefined;
  const logs: string[] = [];
  activate({ log: (l) => logs.push(l), events: { on: (_n, h) => { handler = h; } } }, { readInfo: () => info, fetchImpl, now: () => ++clock });
  const emit = async (paneKey: string, state: string, outcome?: string) =>
    handler!({ workspaceId: WS, paneKey, terminalId: "term_1", title: "Migration", state, ...(outcome ? { mainAgent: { state, outcome } } : {}) });
  return { emit, logs };
}

const statusOf = async (k: Kernel) => (await k.items.provider("apps-connectors")!.list()).find((i) => i.kind === "orca")!;

describe("pont Orca → Floppy", () => {
  it.each([
    ["waiting", undefined, "votre réponse"], ["blocked", "approval", "votre validation"], ["blocked", undefined, "votre intervention"],
  ])("annonce seulement le titre et l'action attendue (%s)", async (state, toolName, action) => {
    const data = { calls: 0, v: wt([ag("p1", "working", { toolName, lastAssistantMessage: "Un long rapport du travail effectué. ".repeat(30) })]) };
    const { got, info } = await start(data);
    const orca = orcaWorker(info);
    await orca.emit("p1", state);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]!.text).toBe(`Migration : l’agent attend ${action}.`);
  });

  it.each(["offline", "missing"])("ne filtre pas une fin à partir de métadonnées anciennes (%s)", async (mode) => {
    const data = { calls: 0, fail: false, v: wt([ag("p1", "working", { prompt: "", activity: { listed: false } })]) };
    const { got, info } = await start(data);
    data.fail = mode === "offline";
    if (mode === "missing") data.v = [];
    const orca = orcaWorker(info);
    await orca.emit("p1", "done");
    await vi.waitFor(() => expect(got).toHaveLength(1));
  });

  it("ignore le cycle d'initialisation sans tâche, puis annonce le vrai travail du même thread", async () => {
    const startup = { prompt: "", taskTitle: null, lastAssistantMessage: null, toolName: null, activity: { listed: false }, hasLivePty: true };
    const data = { calls: 0, v: wt([ag("p1", "done", startup)]) };
    const { got, info } = await start(data);
    const orca = orcaWorker(info);
    await orca.emit("p1", "working");
    await orca.emit("p1", "done");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(got).toEqual([]);
    data.v = wt([ag("p1", "working", { ...startup, prompt: "Corrige le bug", activity: { listed: true } })]);
    await orca.emit("p1", "working");
    data.v = wt([ag("p1", "done", { ...startup, prompt: "Corrige le bug", activity: { listed: true } })]);
    await orca.emit("p1", "done");
    await vi.waitFor(() => expect(got).toHaveLength(1));
  });

  it("annonce deux travaux distincts même si le pont conserve la date initiale du thread", async () => {
    const data = { calls: 0, v: wt([ag("p1", "done", { stateStartedAt: NOW - 1000 })]) };
    const { got, info } = await start(data);
    const orca = orcaWorker(info);
    for (let cycle = 1; cycle <= 2; cycle++) {
      await orca.emit("p1", "working");
      await orca.emit("p1", "done");
      await vi.waitFor(() => expect(got).toHaveLength(cycle));
    }
    expect(got[0]!.key).not.toBe(got[1]!.key);
  });

  it.each(["done", "idle", "unknown"])("ouvrir un thread au repos (%s) ne déclenche pas une annonce de fin", async (state) => {
    const data = { calls: 0, v: wt([ag("p1", state, { stateStartedAt: NOW - 1000 })]) };
    const { got, info } = await start(data);
    const response = await fetch(`http://127.0.0.1:${info.port}/orca`, {
      method: "POST", headers: { Authorization: `Bearer ${info.token}` },
      body: JSON.stringify({ kind: "agent", workspaceId: WS, paneKey: "p1", title: "Codex ready", state: "done", mainAgent: { state: "done", stateStartedAt: NOW + 1 } }),
    });
    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(got).toEqual([]);
    const orca = orcaWorker(info);
    await orca.emit("p1", "working");
    await orca.emit("p1", "done");
    await vi.waitFor(() => expect(got).toHaveLength(1));
  });

  it("de bout en bout : fin annoncée tout de suite, une seule fois, avec le message lu dans Orca", async () => {
    const data = { calls: 0, v: wt([ag("p1", "working")]) };
    const { k, got, info } = await start(data);
    const orca = orcaWorker(info);
    await vi.waitFor(async () => expect(JSON.stringify((await statusOf(k)).statusText)).toContain("prévenu tout de suite"));
    await orca.emit("p1", "working");
    data.v = wt([ag("p1", "done", { taskTitle: "Migration des dates" })]);
    await orca.emit("p1", "done", "success");
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toMatchObject({ key: expect.stringMatching(/^orca:agent_.+:finished$/), importance: "normal" });
    expect(got[0]!.text).toBe("Migration des dates : terminé avec succès.");
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(1);
  });

  it("agent bloqué : annonce importante", async () => {
    const data = { calls: 0, v: wt([ag("p1", "working")]) };
    const { got, info } = await start(data);
    const orca = orcaWorker(info);
    await orca.emit("p1", "working");
    await orca.emit("p1", "blocked");
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]!.importance).toBe("important");
  });

  it("pont en direct : la vérification ralentit ; un état ancien vu par la vérification n'écrase pas le pont", async () => {
    const data = { calls: 0, v: wt([ag("p1", "working")]) };
    const { got, info } = await start(data);
    const orca = orcaWorker(info);
    await orca.emit("p1", "working");
    const n = data.calls;
    await new Promise((r) => setTimeout(r, 150));
    expect(data.calls).toBeLessThanOrEqual(n + 1);
    await orca.emit("p1", "done");
    await vi.waitFor(() => expect(got.length).toBe(1));
  });

  it("refuse un mauvais jeton, une mauvaise adresse, un corps illisible", async () => {
    const { info } = await start({ calls: 0, v: [] });
    const url = `http://127.0.0.1:${info.port}`;
    const auth = { Authorization: `Bearer ${info.token}` };
    expect((await fetch(`${url}/orca`, { method: "POST", headers: { Authorization: "Bearer x" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${url}/orca`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${url}/autre`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
    expect((await fetch(`${url}/orca`, { method: "POST", headers: auth, body: "pas du json" })).status).toBe(400);
    expect((await fetch(`${url}/orca`, { method: "POST", headers: auth, body: "x".repeat(70 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413);
  });

  it("Floppy arrêté : le fichier du pont est retiré", async () => {
    const { k, home } = await start({ calls: 0, v: [] });
    await k.stopAll();
    expect(existsSync(join(home, "orca-bridge.json"))).toBe(false);
  });
});

describe("plugin Orca (worker)", () => {
  it("n'envoie que les vrais changements", () => {
    const changed = changes();
    const e = (state: string): AgentEvent => ({ workspaceId: "w", paneKey: "p", state });
    expect([changed(e("working")), changed(e("working")), changed(e("done")), changed(e("done"))]).toEqual([true, false, true, false]);
  });

  it("relit le fichier quand Floppy a redémarré ; Floppy absent : ne lève pas, le dit une fois", async () => {
    let info: BridgeInfo | undefined = { port: 1, token: "a" };
    const posted: string[] = [];
    const fetchImpl = (async (url: string) => { posted.push(url); return { ok: url.includes(":2/") } as Response; }) as unknown as typeof fetch;
    const logs: string[] = [];
    const send = createBridge({ readInfo: () => info, fetchImpl, log: (l) => logs.push(l) });
    expect(await send({})).toBe(false);
    expect(await send({})).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Floppy ne répond pas (pas lancé ?).");
    info = { port: 2, token: "b" };
    expect(await send({})).toBe(true);
    expect(logs.at(-1)).toBe("Floppy joint.");
    info = undefined;
    expect(await send({})).toBe(true);
  });

  it("trouve le dossier de Floppy comme Floppy, même sans LOCALAPPDATA (Orca ne le donne pas à ses workers)", () => {
    const f = (...p: string[]) => join(...p, "orca-bridge.json");
    expect(bridgeFiles({ FLOPPY_HOME: "/f", LOCALAPPDATA: "/l" }, "/h", "linux")).toEqual([f("/f"), f("/l", "floppy"), f("/h", ".local", "share", "floppy")]);
    expect(bridgeFiles({}, "/h", "win32")).toEqual([f("/h", "AppData", "Local", "floppy"), f("/h", ".local", "share", "floppy")]);
    expect(bridgeFiles({ LOCALAPPDATA: join("/h", "AppData", "Local") }, "/h", "win32")).toEqual([f("/h", "AppData", "Local", "floppy"), f("/h", ".local", "share", "floppy")]);
  });

  it("trouve aussi le répertoire de travail choisi par l'utilisateur (pointeur du dossier par défaut)", () => {
    const f = (...p: string[]) => join(...p, "orca-bridge.json");
    const chosen = (base: string) => (base === join("/h", "AppData", "Local", "floppy") ? "/D/Floppy" : undefined);
    expect(bridgeFiles({}, "/h", "win32", chosen)).toEqual([f("/D/Floppy"), f("/h", "AppData", "Local", "floppy"), f("/h", ".local", "share", "floppy")]);
  });

  it("lit le premier fichier présent ; sinon dit ce qui a été essayé", () => {
    const files = ["/a", "/b"];
    expect(readBridgeInfo(files, (p) => { if (p === "/a") throw new Error("absent"); return '{"port":5,"token":"t"}'; })).toEqual({ port: 5, token: "t" });
    expect(readBridgeInfo(files, () => { throw new Error("absent"); })).toBe("/a : absent ; /b : absent");
  });

  it("états d'Orca", () => {
    expect(kindOfEvent("working", undefined)).toBe("en_cours");
    expect(kindOfEvent("blocked", undefined)).toBe("en_attente");
    expect(kindOfEvent("waiting", undefined)).toBe("en_attente");
    expect(kindOfEvent("done", "interruption")).toBe("interrompu");
    expect(kindOfEvent("done", "success")).toBe("termines");
  });
});
