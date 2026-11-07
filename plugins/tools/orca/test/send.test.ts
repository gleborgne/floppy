import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import { createOrcaPlugin, type OrcaWorktree } from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function start(config: Record<string, unknown> = {}, realCli = false) {
  const data = { calls: 0, v: [
    { worktreeId: "w1", displayName: "Migration", agents: [{ paneKey: "t1:l1", state: "working", agentType: "codex" }] },
    { worktreeId: "w2", displayName: "Revue", agents: [{ paneKey: "t2:l2", state: "waiting", agentType: "claude" }] },
  ] as OrcaWorktree[] };
  const terms = [
    { handle: "term_aaa", worktreeId: "w1", tabId: "t1", leafId: "l1" },
    { handle: "term_bbb", worktreeId: "w2", tabId: "t2", leafId: "l2" },
  ];
  const cli = vi.fn(async (args: string[]): Promise<unknown> => {
    if (args[1] === "list") return { terminals: terms };
    if (args[1] === "send") return { accepted: true };
    throw new Error("commande inattendue");
  });
  const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "orca-send-")), plugins: [createOrcaPlugin({
    run: async () => { data.calls++; return data.v; }, ...(realCli ? {} : { cli }), bridge: false, phrase: async () => undefined,
  })] });
  kernels.push(k);
  const announcements: string[] = [];
  k.bus.on("initiative", (e) => announcements.push(e.text));
  await k.applyConfig({ plugins: [{ id: "orca", plugin: "orca", config: { pollSeconds: 0.02, ...config } }] });
  const announceDone = async () => {
    await vi.waitFor(() => expect(data.calls).toBeGreaterThan(1));
    data.v[0]!.agents![0]!.state = "done";
    await vi.waitFor(() => expect(announcements).toHaveLength(1));
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
  const { k, data, terms, cli } = await start();
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

it("sans annonce, vise le seul agent qui attend et garde le texte dans un argument", async () => {
  const { k, cli } = await start();
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
  expect((await k.tools.call("orca_envoyer", { message: "Continue." })).status).toBe(receipt === "refus" ? "failed" : "unverified");
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")).toHaveLength(1);
});
