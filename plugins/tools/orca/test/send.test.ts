import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type Context } from "@floppy/core";
import { createOrcaPlugin, type OrcaWorktree } from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function start(config: Record<string, unknown> = {}, realCli = false, present = true, prepare?: (wts: OrcaWorktree[]) => void) {
  const data = { calls: 0, v: [
    { worktreeId: "w1", displayName: "Migration", agents: [{ paneKey: "t1:l1", state: "working", agentType: "codex" }] },
    { worktreeId: "w2", displayName: "Revue", agents: [{ paneKey: "t2:l2", state: "waiting", agentType: "claude" }] },
  ] as OrcaWorktree[] };
  prepare?.(data.v);
  const terms = [
    { handle: "term_aaa", worktreeId: "w1", tabId: "t1", leafId: "l1" },
    { handle: "term_bbb", worktreeId: "w2", tabId: "t2", leafId: "l2" },
  ];
  const cli = vi.fn(async (args: string[]): Promise<unknown> => {
    if (args[1] === "list") return { terminals: terms };
    if (args[1] === "send") return { accepted: true };
    throw new Error("commande inattendue");
  });
  let presenter: Context;
  const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "orca-send-")), plugins: [createOrcaPlugin({
    run: async () => { data.calls++; return data.v; }, ...(realCli ? {} : { cli }), bridge: false, phrase: async () => undefined,
  }), definePlugin({ manifest: { id: "presenter", version: "1.0.0", licence: "MIT" }, apply(ctx) { presenter = ctx; } })] });
  kernels.push(k);
  const announcements: string[] = [];
  let delivered = Promise.resolve();
  k.bus.on("initiative", (e) => {
    announcements.push(e.text);
    // Le contexte change à la présentation effective dans ce corps, jamais à la production silencieuse.
    if (present) delivered = presenter.runHook("initiative.presented", { source: e.source, key: e.key, origin: "cli", stage: "scheduled" }, async () => {});
  });
  await k.applyConfig({ plugins: [{ id: "presenter", plugin: "presenter" }, { id: "orca", plugin: "orca", config: { pollSeconds: 0.02, ...config } }] });
  const announceDone = async () => {
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(1));
    data.v[0]!.agents![0]!.state = "done";
    await vi.waitFor(() => expect(announcements).toHaveLength(1));
    await delivered;
  };
  return { k, data, terms, cli, announceDone };
}

it("après « ton agent a fini », transmet « fais le commit » à cet agent après accord", async () => {
  const { k, cli, announceDone } = await start();
  await announceDone();
  const approvals: string[] = [];
  k.bus.on("approval.request", (r) => {
    approvals.push(r.summary);
    expect(cli.mock.calls.some(([a]) => a[1] === "send")).toBe(false);
    k.approvals.respond(r.id, true, "test");
  });
  const r = await k.tools.call("orca_envoyer", { message: "Fais le commit." });
  expect(r.status, r.text).toBe("done");
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toContain("Migration");
  expect(approvals[0]).toContain("Fais le commit.");
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")).toEqual([
    [["terminal", "send", "--terminal", "term_aaa", "--text", "Fais le commit.", "--enter"]],
  ]);
  expect(k.tools.list().find((t) => t.name === "orca_envoyer")?.level).toBe("send");
});

it("un refus n'envoie rien", async () => {
  const { k, cli } = await start();
  k.bus.on("approval.request", (r) => k.approvals.respond(r.id, false, "test"));
  expect((await k.tools.call("orca_envoyer", { nom: "Migration", message: "Fais le commit." })).status).toBe("refused");
  expect(cli.mock.calls.some(([a]) => a[1] === "send")).toBe(false);
});

it("une nouvelle annonce pendant l'accord ne change pas le destinataire", async () => {
  const { k, data, cli, announceDone } = await start();
  await announceDone();
  const approvals: string[] = [];
  k.bus.on("approval.request", (r) => approvals.push(r.id));
  const call = k.tools.call("orca_envoyer", { message: "Fais le commit." });
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  const announced: string[] = [];
  k.bus.on("initiative", (e) => announced.push(e.text));
  data.v[1]!.agents![0]!.state = "working";
  const n = data.calls;
  await vi.waitFor(() => expect(data.calls).toBeGreaterThan(n + 1));
  data.v[1]!.agents![0]!.state = "done";
  await vi.waitFor(() => expect(announced).toHaveLength(1));
  k.approvals.respond(approvals[0]!, true, "test");
  expect((await call).status).toBe("done");
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")[0]![0][3]).toBe("term_aaa");
});

it.each(["agent", "terminal"])("%s disparu pendant l'accord : aucun envoi", async (removed) => {
  const { k, data, terms, cli } = await start();
  k.bus.on("approval.request", (r) => {
    if (removed === "agent") data.v[0]!.agents = [];
    else terms[0]!.handle = "term_replacement";
    k.approvals.respond(r.id, true, "test");
  });
  expect((await k.tools.call("orca_envoyer", { nom: "Migration", message: "Continue." })).status).toBe("failed");
  expect(cli.mock.calls.some(([a]) => a[1] === "send")).toBe(false);
});

it.each(["ambigu", "terminal absent", "identifiant invalide", "worker", "sans cible"])("%s : refuse avant l'accord", async (scenario) => {
  const { k, data, terms, cli } = await start({}, false, false);
  if (scenario === "ambigu") data.v[0]!.agents!.push({ paneKey: "t3:l3", state: "done" });
  if (scenario === "terminal absent") terms[0]!.leafId = "autre";
  if (scenario === "identifiant invalide") terms[0]!.handle = "term_x & calc";
  if (scenario === "worker") data.v[0]!.agents![0]!.conversationName = "worker-task_123";
  if (scenario === "sans cible") data.v[1]!.agents![0]!.state = "done";
  const approval = vi.fn((r: { id: string }) => k.approvals.respond(r.id, false, "test"));
  k.bus.on("approval.request", approval);
  const r = await k.tools.call("orca_envoyer", { ...(scenario === "sans cible" ? {} : { nom: "Migration" }), message: "Continue." });
  expect(r.status, r.text).toBe("failed");
  expect(approval).not.toHaveBeenCalled();
  expect(cli.mock.calls.some(([a]) => a[1] === "send")).toBe(false);
});

it("le dernier annoncé disparu ne se rabat pas sur un autre agent en attente", async () => {
  const { k, data, cli, announceDone } = await start();
  await announceDone();
  data.v.shift();
  expect((await k.tools.call("orca_envoyer", { message: "Continue." })).text).toContain("plus disponible");
  expect(cli).not.toHaveBeenCalled();
});

it("après sa fiche, vise l'agent de cette conversation et garde le texte dans un argument", async () => {
  const { k, cli } = await start();
  await k.tools.call("orca_detail", { nom: "Revue" });
  k.bus.on("approval.request", (r) => k.approvals.respond(r.id, true, "test"));
  const message = 'Écris "fix: dates" puis commit ; $(test) & %PATH% `texte`';
  expect((await k.tools.call("orca_envoyer", { message })).status).toBe("done");
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")[0]![0]).toEqual(["terminal", "send", "--terminal", "term_bbb", "--text", message, "--enter"]);
});

it.each(["", "  ", "un\ndeux", "un\rdeux", "un\x1bdeux", "x".repeat(4001), "--interrupt"])("message invalide : %j", async (message) => {
  const { k, cli } = await start();
  expect((await k.tools.call("orca_envoyer", { message })).status).toBe("failed");
  expect(cli).not.toHaveBeenCalled();
});

it.each(["orca.cmd", "orca.bat"])("refuse l'envoi via %s", async (command) => {
  const { k } = await start({ command }, true);
  const r = await k.tools.call("orca_envoyer", { message: "Continue." });
  expect(r.status).toBe("failed");
  expect(r.text).toContain("sans script intermédiaire");
});

it.each(["refus", "inconnu", "erreur"])("accusé %s : ne prétend pas avoir envoyé et ne réessaie pas", async (receipt) => {
  const { k, cli } = await start();
  const original = cli.getMockImplementation()!;
  cli.mockImplementation(async (args) => {
    if (args[1] !== "send") return original(args);
    if (receipt === "erreur") throw new Error("timeout");
    return receipt === "refus" ? { accepted: false } : {};
  });
  k.bus.on("approval.request", (r) => k.approvals.respond(r.id, true, "test"));
  expect((await k.tools.call("orca_envoyer", { nom: "Revue", message: "Continue." })).status).toBe(receipt === "refus" ? "failed" : "unverified");
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")).toHaveLength(1);
});

it.each(["input_accepted", "turn_started"])("un reçu moderne %s garde son identifiant durable sans divulguer la consigne", async stage => {
  const { k, cli } = await start();
  const original = cli.getMockImplementation()!;
  cli.mockImplementation(args => args[1] === "send" ? Promise.resolve({ send: { accepted: true, prompt: { requestId: "durable-id", stages: ["input_accepted", ...(stage === "turn_started" ? [stage] : [])] } } }) : original(args));
  k.bus.on("approval.request", r => k.approvals.respond(r.id, true, "test"));
  const r = await k.tools.call("orca_envoyer", { nom: "Revue", message: "Instruction confidentielle unique." });
  expect(r.status).toBe("done"); expect(r.text).toContain("ne confirme pas");
  const audit = k.audit.tail(100);
  expect(audit.some(e => e.kind === "orca.delivery" && e.stage === stage && typeof e.requestHash === "string")).toBe(true);
  expect(JSON.stringify(audit)).not.toContain("durable-id");
  expect(JSON.stringify(audit)).not.toContain("Instruction confidentielle unique");
});

it("un agent redevenu actif pendant l'accord est ignoré avec une trace, sans interruption", async () => {
  const { k, cli, data } = await start();
  k.bus.on("approval.request", r => { data.v[1]!.agents![0]!.state = "working"; k.approvals.respond(r.id, true, "test"); });
  const r = await k.tools.call("orca_envoyer", { nom: "Revue", message: "Continue." });
  expect(r.status).toBe("failed"); expect(r.text).toContain("travaille à nouveau");
  expect(cli.mock.calls.some(([args]) => args[1] === "send")).toBe(false);
  expect(k.audit.tail(100).some(e => e.kind === "orca.delivery" && e.stage === "skipped" && e.reason === "state-changed")).toBe(true);
});

it("un terminal réincarné sous le même handle est ignoré", async () => {
  const { k, cli, terms } = await start();
  (terms[1] as unknown as Record<string, unknown>).processIncarnation = "one";
  k.bus.on("approval.request", r => { (terms[1] as unknown as Record<string, unknown>).processIncarnation = "two"; k.approvals.respond(r.id, true, "test"); });
  expect((await k.tools.call("orca_envoyer", { nom: "Revue", message: "Continue." })).status).toBe("failed");
  expect(cli.mock.calls.some(([args]) => args[1] === "send")).toBe(false);
});

it("un menu de permission est refusé avant l'accord", async () => {
  const { k, cli, data } = await start();
  data.v[1]!.agents![0]!.state = "permission";
  const approve = vi.fn(); k.bus.on("approval.request", approve);
  expect((await k.tools.call("orca_envoyer", { nom: "Revue", message: "Oui." })).status).toBe("failed");
  expect(approve).not.toHaveBeenCalled(); expect(cli.mock.calls.some(([args]) => args[1] === "send")).toBe(false);
});

it("la confirmation et le résultat nomment la tâche et Floppy malgré un espace appelé assistant", async () => {
  const { k } = await start({}, false, true, wts => {
    wts[1]!.displayName = "assistant"; wts[1]!.repo = "Floppy";
    wts[1]!.agents![0]!.taskTitle = "Corriger les mails";
  });
  const confirmations: string[] = [];
  k.bus.on("approval.request", r => { confirmations.push(r.summary); k.approvals.respond(r.id, true, "test"); });
  const result = await k.tools.call("orca_envoyer", { nom: "Corriger les mails", message: "Instruction privée unique." });
  expect(result.status).toBe("done");
  for (const text of [confirmations[0]!, result.text]) { expect(text).toContain("Corriger les mails"); expect(text).toContain("Floppy"); expect(text).not.toContain("t2:l2"); expect(text).not.toContain("w2"); }
  expect(result.text).not.toContain("Instruction privée unique");
});
