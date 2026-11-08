import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin } from "@floppy/core";
import type { AgentTrackingService } from "@floppy/contracts";
import { createOrcaPlugin, type OrcaAgent, type OrcaTerminal, type OrcaWorktree } from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });
const until = async (test: () => void) => vi.waitFor(test, { interval: 5, timeout: 2000 });
const NOW = Date.parse("2026-11-08T15:00:00Z");
async function setup(opts: { home?: string; at?: number; state?: string; stateAt?: number; receipt?: "input_accepted" | "turn_started"; bridge?: boolean; independent?: boolean } = {}) {
  let time = opts.at ?? NOW;
  const initial = opts.state ?? "done", initialAt = opts.stateAt ?? time - 1000;
  const make = (name: string): OrcaAgent => ({ paneKey: `tab:${name}`, taskTitle: `${name} task`, displayName: name, agentType: "codex", state: initial, stateStartedAt: initialAt, mainAgent: { state: initial, stateStartedAt: initialAt }, sessionId: `${name}-session`, incarnation: "agent-1", hasLivePty: true, updatedAt: initialAt });
  const rows: OrcaWorktree[] = [{ worktreeId: "repo::C:/shared", displayName: "Floppy", repo: "Floppy", agents: [make("Bob"), make("Alice")] }];
  if (opts.independent) rows.push({ worktreeId: "repo::C:/other", displayName: "Other", agents: [make("Chloe")] });
  const terms: (OrcaTerminal & { processIncarnation: string })[] = rows.flatMap(w => w.agents!.map(a => ({ handle: `term_${a.displayName}`, worktreeId: w.worktreeId, tabId: "tab", leafId: a.displayName!, processIncarnation: "terminal-1" })));
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "orca-runtime-guard-"));
  const run = vi.fn(async () => structuredClone(rows));
  const cli = vi.fn(async (args: string[]): Promise<unknown> => {
    if (args[1] === "list") return { terminals: structuredClone(terms) };
    if (args[1] === "send") return { send: { accepted: true, prompt: { requestId: "request-private", stages: [opts.receipt ?? "input_accepted"] } } };
    throw new Error("unexpected simulated CLI command");
  });
  let tracking!: AgentTrackingService;
  const k = new Kernel({ home, logger: () => {}, plugins: [createOrcaPlugin({ cli, run, now: () => time, bridge: opts.bridge ?? false, phrase: async () => undefined }), definePlugin({ manifest: { id: "probe", version: "1", licence: "MIT", inject: ["agentTracking"] }, apply(ctx) { tracking = ctx.get("agentTracking"); } })] });
  kernels.push(k);
  k.bus.on("approval.request", e => k.approvals.respond(e.id, true, "test"));
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 600, notifications: "aucune" } }, { id: "probe", plugin: "probe" }] });
  await tracking.refresh();
  if (opts.bridge) await until(() => expect(existsSync(join(home, "orca-bridge.json"))).toBe(true));
  const file = join(home, "orca-checkout-protection.json");
  const locks = () => (JSON.parse(readFileSync(file, "utf8")) as { locks: { settled: boolean; observedWorking: boolean; workingStartedAt?: number; oldTurnEndedAt?: number }[] }).locks;
  const single = (nom = "Bob") => k.tools.call("orca_envoyer", { nom, message: "Private instruction" });
  const sends = () => cli.mock.calls.filter(([a]) => a[1] === "send").map(([a]) => a);
  const lists = () => cli.mock.calls.filter(([a]) => a[1] === "list").length;
  const bob = () => rows[0]!.agents![0]!;
  const set = (state: string, at = time, a = bob()) => { a.state = state; a.stateStartedAt = at; a.mainAgent = { state, stateStartedAt: at }; a.updatedAt = time; };
  let sequence = 0;
  const push = async (state: string, at: number | null = time) => {
    const info = JSON.parse(readFileSync(join(home, "orca-bridge.json"), "utf8"));
    const r = await fetch(`http://127.0.0.1:${info.port}/orca`, { method: "POST", headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ kind: "agent", workspaceId: rows[0]!.worktreeId, paneKey: bob().paneKey, state, mainAgent: { state, stateStartedAt: at === null ? undefined : at }, bridgeId: "bridge-test", eventId: `event-${++sequence}`, sequence, receivedAt: time, sentAt: time }) });
    expect(r.status).toBe(204);
  };
  return { k, home, rows, terms, cli, run, locks, single, sends, lists, bob, set, push, poll: () => tracking.refresh(), advance(ms = 10) { time += ms; }, time: () => time };
}

it.each(["input_accepted", "turn_started"] as const)("vrai runtime %s : polling working puis done libère le prochain individuel sans champ de fin inventé", async receipt => {
  const s = await setup({ receipt });
  const before = s.lists(); await s.poll(); await s.poll(); expect(s.lists()).toBe(before);
  expect((await s.single()).status).toBe("done");
  s.advance(); s.set("working"); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(true);
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(0);
  const cleared = s.lists(); await s.poll(); expect(s.lists()).toBe(cleared);
  expect((await s.single()).status).toBe("done"); expect(s.sends()).toHaveLength(2);
});

it("le pont alimente le même registre via sa collecte, même si la CLI garde un ancien done", async () => {
  const s = await setup({ bridge: true }); await s.single();
  s.advance(); await s.push("working");
  await until(() => expect(s.locks()[0]!.observedWorking).toBe(true));
  s.advance(); await s.push("done");
  await until(() => expect(s.locks()).toHaveLength(0));
  expect((await s.single()).status).toBe("done"); expect(s.sends()).toHaveLength(2);
});

it("un cycle push rapide pendant une lecture terminal suspendue est vérifié dans l'ordre par la collecte suivante", async () => {
  const s = await setup({ bridge: true }); await s.single();
  let resolve!: (v: unknown) => void; const terminal = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!, before = s.lists(); s.cli.mockImplementationOnce(() => terminal);
  s.advance(); await s.push("working"); await until(() => expect(s.lists()).toBe(before + 1));
  s.advance(); await s.push("done");
  s.cli.mockImplementation(old); resolve({ terminals: s.terms });
  await until(() => expect(s.locks()).toHaveLength(0));
  expect(s.sends()).toHaveLength(1); expect((await s.single()).status).toBe("done");
});

it("un push sans date de début ne réutilise pas la date de l'ancien état comme preuve", async () => {
  const s = await setup({ bridge: true }); await s.single();
  s.advance(); await s.push("working", null); await s.poll();
  s.advance(); await s.push("done"); await s.poll();
  expect(s.locks()[0]!.observedWorking).toBe(false); expect(s.locks()).toHaveLength(1);
});

it("une preuve de travail collectée reste utilisable au redémarrage du runtime sans réémission", async () => {
  const s = await setup(); await s.single();
  s.advance(); s.set("working"); await s.poll();
  const workingAt = s.time(); await s.k.stopAll();
  const next = await setup({ home: s.home, at: workingAt + 100, stateAt: workingAt + 50 });
  expect(next.locks()).toHaveLength(0); expect(next.sends()).toHaveLength(0);
  expect((await next.single("Alice")).status).toBe("done"); expect(next.sends()).toHaveLength(1);
});

it.each(["cycle", "last-state", "baseline", "old-end", "cycle-boundary"])("une preuve temporelle restaurée incohérente %s reste fermée", async invalid => {
  const s = await setup(); await s.single(); await s.k.stopAll();
  const file = join(s.home, "orca-checkout-protection.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  const lock = value.locks[0];
  if (invalid === "cycle") Object.assign(lock, { observedWorking: true, allowTransition: true, workingStartedAt: NOW - 1, lastStateAt: NOW + 1 });
  if (invalid === "last-state") lock.lastStateAt = NOW - 1;
  if (invalid === "baseline") lock.baselineIdleAt = NOW + 1;
  if (invalid === "old-end") Object.assign(lock, { initiallyWorking: true, oldTurnEndedAt: NOW - 1, lastStateAt: NOW + 10 });
  if (invalid === "cycle-boundary") Object.assign(lock, { initiallyWorking: true, oldTurnEndedAt: NOW + 20, lastStateAt: NOW + 20, workingStartedAt: NOW + 10, observedWorking: true, allowTransition: true });
  writeFileSync(file, JSON.stringify(value));
  const next = await setup({ home: s.home, at: NOW + 100, stateAt: NOW + 50 });
  expect((await next.single()).status).toBe("failed"); expect(next.sends()).toHaveLength(0);
});

it("initialement working : l'ancien tour et sa fin ne libèrent pas, un nouveau début daté puis sa fin libèrent", async () => {
  const s = await setup({ state: "working" }); expect((await s.single()).status).toBe("done");
  s.advance(); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(false);
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(1);
  s.advance(); s.set("working"); await s.poll(); expect(s.locks()[0]!.workingStartedAt).toBe(s.time());
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(0);
  expect((await s.single()).status).toBe("done");
});

it("initialement working : une nouvelle horloge working seule ne suffit pas avant une fin observée", async () => {
  const s = await setup({ state: "working" }); await s.single();
  s.advance(); s.set("working"); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(false);
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(1);
  s.advance(); s.set("working"); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(true);
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(0);
});

it.each(["waiting", "blocked", "permission"])("reprise %s de l'ancien tour : sa nouvelle horloge working ne libère pas la consigne suivante", async pause => {
  const s = await setup({ state: "working" }); await s.single();
  s.advance(); s.set(pause === "permission" ? "waiting" : pause);
  if (pause === "permission") s.bob().toolName = "permission";
  await s.poll(); delete s.bob().toolName;
  s.advance(); s.set("working"); await s.poll();
  expect(s.locks()[0]!.observedWorking).toBe(false);
  s.advance(); s.set("done"); await s.poll();
  expect(s.locks()).toHaveLength(1);
  expect((await s.single("Alice")).status).toBe("failed"); expect(s.sends()).toHaveLength(1);
  s.advance(); s.set("working"); await s.poll();
  s.advance(); s.set("done"); await s.poll();
  expect(s.locks()).toHaveLength(0);
  expect((await s.single("Alice")).status).toBe("done"); expect(s.sends()).toHaveLength(2);
});

it("une fin identifiée répétée après l'ancien tour ne remplace pas l'observation du nouveau working", async () => {
  const s = await setup({ state: "working", receipt: "turn_started" }); await s.single();
  s.advance(); s.set("done");
  Object.assign(s.bob(), { turnEndedAt: s.time(), turnEndDisposition: "identified" });
  await s.poll(); expect(s.locks()).toHaveLength(1);
  expect((await s.single("Alice")).status).toBe("failed"); expect(s.sends()).toHaveLength(1);
  s.advance(); s.set("working"); await s.poll();
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(0);
});

it.each(["before-old-end", "after-old-end", "after-new-start"])("le redémarrage %s conserve la frontière entre l'ancien et le nouveau tour", async stage => {
  const s = await setup({ state: "working" }); await s.single();
  s.advance(); s.set("waiting"); await s.poll();
  s.advance(); s.set("working"); await s.poll();
  if (stage !== "before-old-end") { s.advance(); s.set("done"); await s.poll(); }
  const oldEnd = s.locks()[0]!.oldTurnEndedAt;
  if (stage === "after-new-start") { s.advance(); s.set("working"); await s.poll(); }
  const state = s.bob().state!, stateAt = s.bob().stateStartedAt!;
  await s.k.stopAll();
  const next = await setup({ home: s.home, at: s.time() + 100, state, stateAt });
  expect(next.locks()).toHaveLength(1); expect(next.locks()[0]!.oldTurnEndedAt).toBe(oldEnd); expect(next.sends()).toHaveLength(0);
  if (stage === "before-old-end") { next.advance(); next.set("done"); await next.poll(); expect(next.locks()).toHaveLength(1); }
  if (stage !== "after-new-start") { next.advance(); next.set("working"); await next.poll(); }
  next.advance(); next.set("done"); await next.poll(); expect(next.locks()).toHaveLength(0);
  expect((await next.single("Alice")).status).toBe("done"); expect(next.sends()).toHaveLength(1);
});

it("une reprise antérieure à la fin observée et une ancienne fin tardive ne changent pas le cycle", async () => {
  const s = await setup({ state: "working" }); await s.single();
  s.advance(30); s.set("done"); await s.poll();
  s.advance(); s.set("working", NOW + 20); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(false);
  s.advance(); s.set("working"); await s.poll(); expect(s.locks()[0]!.observedWorking).toBe(true);
  s.advance(); s.set("done", NOW + 30); await s.poll(); expect(s.locks()).toHaveLength(1);
  s.advance(); s.set("done"); await s.poll(); expect(s.locks()).toHaveLength(0);
});

it.each(["ambiguous-working", "known-idle"])("un ancien état %s est restauré sans faire confiance à une reprise ambiguë", async legacy => {
  const s = await setup({ state: legacy === "known-idle" ? "done" : "working" }); await s.single();
  s.advance(); s.set("working"); await s.poll(); await s.k.stopAll();
  const file = join(s.home, "orca-checkout-protection.json"), value = JSON.parse(readFileSync(file, "utf8"));
  const lock = value.locks[0]; delete lock.initiallyWorking; delete lock.oldTurnEndedAt;
  // Forme réellement produite par la version précédente après une simple reprise de l'ancien tour.
  Object.assign(lock, { observedWorking: true, allowTransition: true, workingStartedAt: s.time(), lastStateAt: s.time() });
  writeFileSync(file, JSON.stringify(value));
  const next = await setup({ home: s.home, at: s.time() + 100, stateAt: s.time() + 50 });
  if (legacy === "known-idle") expect(next.locks()).toHaveLength(0);
  else {
    expect(next.locks()).toHaveLength(1); expect(next.locks()[0]!.observedWorking).toBe(false);
    expect((await next.single("Alice")).status).toBe("failed");
    next.advance(); next.set("working"); await next.poll(); next.advance(); next.set("done"); await next.poll();
    expect(next.locks()).toHaveLength(0);
  }
});

it("un ancien working reçu tardivement par le pont ne devient pas une preuve du nouveau tour", async () => {
  const s = await setup({ bridge: true }); await s.single();
  s.advance(); await s.push("working", NOW - 1); await s.poll();
  s.advance(); await s.push("done"); await s.poll();
  expect(s.locks()[0]!.observedWorking).toBe(false);
  expect((await s.single("Alice")).status).toBe("failed"); expect(s.sends()).toHaveLength(1);
});

it("un working postérieur à l'envoi mais antérieur au done déjà collecté reste un relevé ancien", async () => {
  const s = await setup({ state: "working" }); await s.single();
  s.advance(20); s.set("done"); await s.poll();
  s.advance(10); s.set("working", NOW + 10); await s.poll();
  expect(s.locks()[0]!.observedWorking).toBe(false);
  s.advance(); s.set("done", NOW + 20); await s.poll();
  expect(s.locks()).toHaveLength(1); expect((await s.single("Alice")).status).toBe("failed");
});

it.each(["input_accepted", "turn_started"] as const)("cycle rapide initialement au repos %s : une fin seule exige le reçu durable de démarrage", async receipt => {
  const s = await setup({ receipt }); await s.single();
  s.advance(); s.set("done"); await s.poll();
  expect(s.locks()).toHaveLength(receipt === "turn_started" ? 0 : 1);
  expect((await s.single("Alice")).status).toBe(receipt === "turn_started" ? "done" : "failed");
  expect(s.sends()).toHaveLength(receipt === "turn_started" ? 2 : 1);
});

it("sans pont ni observation du travail entre deux collectes, input_accepted ne prouve pas un cycle rapide", async () => {
  const s = await setup(); await s.single();
  s.advance(); s.set("working"); s.advance(); s.set("done");
  expect((await s.single("Alice")).status).toBe("failed"); expect(s.sends()).toHaveLength(1);
});

it("une liste terminal est mutualisée par collecte entre dossiers verrouillés", async () => {
  const s = await setup({ independent: true }); await s.single(); await s.single("Chloe");
  s.advance(); s.set("working"); s.set("working", s.time(), s.rows[1]!.agents![0]!);
  const before = s.lists(); await s.poll(); expect(s.lists() - before).toBe(1);
  expect(s.locks().every(l => l.observedWorking)).toBe(true);
});

it.each(["session", "terminal"])("une identité %s remplacée ne libère pas le verrou lors de la collecte", async replaced => {
  const s = await setup(); await s.single();
  if (replaced === "session") s.bob().sessionId = "replacement";
  else s.terms[0]!.processIncarnation = "replacement";
  s.advance(); s.set("working"); await s.poll(); s.advance(); s.set("done"); await s.poll();
  expect(s.locks()).toHaveLength(1); expect(s.locks()[0]!.observedWorking).toBe(false);
  expect((await s.single("Alice")).status).toBe("failed"); expect(s.sends()).toHaveLength(1);
});

it("une erreur de terminal list ne fabrique pas une observation de travail", async () => {
  const s = await setup(); await s.single();
  const old = s.cli.getMockImplementation()!; s.cli.mockImplementationOnce(() => Promise.reject(new Error("offline")));
  s.advance(); s.set("working"); await s.poll();
  s.cli.mockImplementation(old); s.advance(); s.set("done"); await s.poll();
  expect(s.locks()[0]!.observedWorking).toBe(false); expect(s.locks()).toHaveLength(1);
});

it("un callback terminal suspendu n'utilise pas les preuves d'une ancienne incarnation après un push", async () => {
  const s = await setup({ bridge: true }); await s.single();
  s.advance(); s.set("working");
  let resolve!: (v: unknown) => void; const terminal = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!, before = s.lists(); s.cli.mockImplementationOnce(() => terminal);
  const pending = s.poll(); await until(() => expect(s.lists()).toBe(before + 1));
  s.bob().sessionId = "replacement"; s.advance(); s.set("done"); await s.push("done");
  s.cli.mockImplementation(old); resolve({ terminals: s.terms }); await pending;
  await s.poll(); expect(s.locks()).toHaveLength(1); expect(s.locks()[0]!.observedWorking).toBe(false);
});

it("un transport pending puis son ancien callback après arrêt ne libèrent pas au runtime restauré", async () => {
  const s = await setup(); let resolve!: (v: unknown) => void;
  const receipt = new Promise<unknown>(r => { resolve = r; }); const old = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? receipt : old(args));
  const first = s.single(); await until(() => expect(s.sends()).toHaveLength(1));
  const before = s.lists(); s.advance(); s.set("working"); await s.poll(); s.advance(); s.set("done"); await s.poll();
  expect(s.lists()).toBe(before); expect(s.locks()[0]!.settled).toBe(false);
  await s.k.stopAll();
  const next = await setup({ home: s.home, at: s.time() + 100, stateAt: s.time() + 50 });
  resolve({ send: { accepted: true, prompt: { requestId: "late", stages: ["turn_started"] } } }); await first;
  next.advance(); next.set("working"); await next.poll(); next.advance(); next.set("done"); await next.poll();
  expect(next.locks()[0]!.settled).toBe(false); expect((await next.single("Alice")).status).toBe("failed"); expect(next.sends()).toHaveLength(0);
});

it("la libération par collecte ne rejoue pas un groupe annulé, mais autorise une nouvelle consigne", async () => {
  const s = await setup(); await s.k.tools.call("orca_agents", { projet: "Floppy", filtre: "termines" });
  const group = await s.k.tools.call("orca_envoyer_groupe", { message: "Private group instruction" });
  expect(group.status).toBe("done"); await until(() => expect(s.sends()).toHaveLength(1));
  const first = s.sends()[0]![3]!, name = first.slice("term_".length), other = name === "Bob" ? "Alice" : "Bob";
  const recipient = s.rows[0]!.agents!.find(a => a.displayName === name)!;
  await s.k.tools.call("orca_annuler_envoi", { plan: (group.raw as { planId: string }).planId });
  s.advance(); s.set("working", s.time(), recipient); await s.poll(); s.advance(); s.set("done", s.time(), recipient); await s.poll();
  expect(s.locks()).toHaveLength(0); expect(s.sends()).toHaveLength(1);
  expect((await s.single(other)).status).toBe("done"); expect(s.sends().map(a => a[3])).toEqual([first, `term_${other}`]);
});

it("un groupe actif progresse grâce au runtime et sa trace de fin conserve l'état réellement observé", async () => {
  const s = await setup(); await s.k.tools.call("orca_agents", { projet: "Floppy", filtre: "termines" });
  await s.k.tools.call("orca_envoyer_groupe", { message: "Private group instruction" });
  await until(() => expect(s.sends()).toHaveLength(1));
  const name = s.sends()[0]![3]!.slice("term_".length), recipient = s.rows[0]!.agents!.find(a => a.displayName === name)!;
  s.advance(); s.set("working", s.time(), recipient); await s.poll();
  s.advance(); s.set("done", s.time(), recipient); await s.poll();
  expect(s.k.audit.tail(200).some(e => e.kind === "orca.delivery" && e.stage === "completed" && e.observedState === "done" && e.provenance === "cli-snapshot")).toBe(true);
  await until(() => expect(s.sends()).toHaveLength(2));
});
