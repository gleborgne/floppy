import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type ToolCallMeta } from "@floppy/core";
import type { Hit, OrcaTerminal, OrcaWorktree } from "../src/index.ts";
import { groupSendTools, type GroupSendDeps } from "../src/group-send.ts";
import { receiptOf, type DeliveryFact } from "../src/send-support.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });
async function setup(opts: { receipt?: unknown; timeoutMs?: number; home?: string; autoApprove?: boolean; before?: (w: OrcaWorktree[]) => void; label?: GroupSendDeps["label"]; persistence?: GroupSendDeps["persistence"] } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "orca-group-"));
  const wts: OrcaWorktree[] = [
    { worktreeId: "r::C:/shared", displayName: "Floppy", agents: [
      { paneKey: "t:a", agentType: "codex", displayName: "Alice", taskTitle: "Needs commit", state: "done" },
      { paneKey: "t:b", agentType: "claude", displayName: "Bob", taskTitle: "Already committed", state: "done" },
      { paneKey: "t:c", agentType: "codex", displayName: "Chloe", taskTitle: "Analysis only", state: "done" },
      { paneKey: "t:d", agentType: "claude", displayName: "Dan", taskTitle: "Tests", state: "done" },
    ] },
  ];
  const terms: OrcaTerminal[] = wts.flatMap(w => w.agents!.map(a => ({ worktreeId: w.worktreeId, handle: `term_${a.paneKey.split(":")[1]}`, tabId: "t", leafId: a.paneKey.split(":")[1] })));
  const facts: DeliveryFact[] = [];
  const problems: Parameters<NonNullable<GroupSendDeps["persistenceDiagnostic"]>>[0][] = [];
  const announce = vi.fn();
  const cli = vi.fn(async (args: string[]): Promise<unknown> => {
    if (args[1] === "list") return { terminals: terms };
    return opts.receipt ?? { send: { accepted: true, prompt: { requestId: `req_${args[3]}`, stages: ["input_accepted"] } } };
  });
  let selected: Hit[] | undefined;
  const select = vi.fn((_w: OrcaWorktree[], _args: Record<string, unknown>, _meta: ToolCallMeta) => selected ?? wts.flatMap(w => w.agents!.map(a => ({ w, a }))));
  const k = new Kernel({ logger: () => {}, home, plugins: [definePlugin({
    manifest: { id: "group-test", version: "1.0.0", licence: "MIT", description: "Test", permissions: {} },
    apply(ctx) { ctx.tools.register(groupSendTools({ ctx, cli, run: async () => wts, direct: () => true, select, onDelivery: f => facts.push(f), announce, pollMs: 3, timeoutMs: opts.timeoutMs ?? 1000, label: opts.label, persistence: opts.persistence, persistenceDiagnostic: f => problems.push(f) })); },
  })] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "test", plugin: "group-test" }] });
  const approvals: { id: string; summary: string }[] = [];
  k.bus.on("approval.request", r => { approvals.push(r); opts.before?.(wts); if (opts.autoApprove !== false) k.approvals.respond(r.id, true, "test"); });
  const sends = () => cli.mock.calls.filter(([a]) => a[1] === "send").map(([a]) => a);
  const call = (meta: ToolCallMeta = {}) => k.tools.call("orca_envoyer_groupe", { nom: "Floppy", filtre: "termines", message: "Commit your work if needed." }, meta);
  const selectOnly = (indices: number[]) => { selected = indices.map(i => ({ w: wts[0]!, a: wts[0]!.agents![i]! })); };
  return { k, home, wts, terms, facts, problems, announce, cli, select, approvals, sends, call, selectOnly };
}
const until = async (test: () => void) => vi.waitFor(test, { interval: 5, timeout: 1500 });

it("un accord nomme les quatre tâches et la consigne exacte, sans considérer done comme preuve de commit", async () => {
  const s = await setup({ before: w => { w[0]!.agents![3]!.state = "working"; } });
  expect((await s.call()).status).toBe("done");
  expect(s.approvals).toHaveLength(1);
  for (const name of ["Alice", "Bob", "Chloe", "Dan", "Floppy", "Needs commit", "Already committed", "Analysis only", "Commit your work if needed."]) expect(s.approvals[0]!.summary).toContain(name);
  await until(() => expect(s.sends()).toHaveLength(1));
  s.wts[0]!.agents![0]!.state = "working";
  await until(() => expect(s.facts.some(f => f.paneKey === "t:a" && f.stage === "turn_started")).toBe(true));
  s.wts[0]!.agents![0]!.state = "done";
  await until(() => expect(s.sends()).toHaveLength(2));
  s.wts[0]!.agents![1]!.state = "working";
  await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "turn_started")).toBe(true));
  s.wts[0]!.agents![1]!.state = "done";
  await until(() => expect(s.sends()).toHaveLength(3));
  s.wts[0]!.agents![2]!.state = "working";
  await until(() => expect(s.facts.some(f => f.paneKey === "t:c" && f.stage === "turn_started")).toBe(true));
  s.wts[0]!.agents![2]!.state = "done";
  await until(() => expect(s.announce).toHaveBeenCalled());
  expect(s.sends()).toHaveLength(3);
  expect(s.facts.some(f => f.paneKey === "t:d" && f.stage === "skipped" && f.reason === "state-changed")).toBe(true);
  const status = await s.k.tools.call("orca_envois", {});
  expect(status.text).toContain("Alice"); expect(status.text).toContain("Dan"); expect(status.text).toContain("travail non vérifié");
});

it("une acceptation seule ne libère jamais le dossier ; aucun renvoi après délai", async () => {
  const s = await setup({ timeoutMs: 25 });
  await s.call();
  await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  expect(s.sends()).toHaveLength(1);
  expect(s.facts.some(f => f.stage === "timeout" && f.reason === "start-unconfirmed")).toBe(true);
  expect(s.facts.find(f => f.stage === "input_accepted")?.requestId).toBe("req_term_a");
});

it("un tour démarré sans fin observée expire et diffère les suivants", async () => {
  const s = await setup({ timeoutMs: 60 });
  await s.call(); await until(() => expect(s.sends()).toHaveLength(1));
  s.wts[0]!.agents![0]!.state = "working";
  await until(() => expect(s.facts.some(f => f.stage === "timeout" && f.reason === "completion-timeout")).toBe(true));
  await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  expect(s.sends()).toHaveLength(1);
});

it("les autres checkouts progressent indépendamment", async () => {
  const s = await setup();
  const moved = s.wts[0]!.agents!.splice(1);
  s.wts.push({ worktreeId: "r::C:/other", displayName: "Other", agents: moved });
  for (const t of s.terms.slice(1)) t.worktreeId = "r::C:/other";
  await s.call(); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends().map(a => a[3])).toEqual(["term_a", "term_b"]);
});

it.each(["gone", "replaced", "permission", "worker", "state"])("revalidation %s : exclusion nommée sans autre terminal", async scenario => {
  const s = await setup(); s.selectOnly([0]);
  s.k.bus.on("approval.request", () => {
    if (scenario === "gone") s.wts[0]!.agents = [];
    if (scenario === "replaced") s.terms[0]!.handle = "term_new";
    if (scenario === "permission") s.wts[0]!.agents![0]!.state = "permission";
    if (scenario === "worker") s.wts[0]!.agents![0]!.conversationName = "worker-task_123";
    if (scenario === "state") s.wts[0]!.agents![0]!.state = "working";
  });
  await s.call(); await until(() => expect(s.facts.some(f => f.stage === "skipped")).toBe(true));
  expect(s.sends()).toHaveLength(0);
  expect((await s.k.tools.call("orca_envois", {})).text).toContain("Alice");
});

it("un nouveau destinataire pendant l'accord ne rejoint pas la sélection figée", async () => {
  const s = await setup(); s.selectOnly([0]);
  s.k.bus.on("approval.request", () => s.wts[0]!.agents!.push({ paneKey: "t:new", state: "done", agentType: "codex" }));
  await s.call(); await until(() => expect(s.sends()).toHaveLength(1));
  expect(s.facts.every(f => f.paneKey === "t:a")).toBe(true);
});

it.each(["worker", "permission", "unknown"])("%s est refusé avec son nom avant l'accord", async scenario => {
  const s = await setup(); s.selectOnly([0]);
  if (scenario === "worker") s.wts[0]!.agents![0]!.conversationName = "worker-task_123";
  if (scenario === "permission") s.wts[0]!.agents![0]!.state = "permission";
  if (scenario === "unknown") delete s.wts[0]!.agents![0]!.agentType;
  const r = await s.call(); expect(r.status).toBe("failed"); expect(r.text).toContain("Alice");
  expect(s.approvals).toHaveLength(0); expect(s.sends()).toHaveLength(0);
});

it.each([{}, { send: { accepted: false } }, { accepted: true }])("accusé %j : aucun renvoi ni succès du travail", async receipt => {
  const s = await setup({ receipt, timeoutMs: 25 }); s.selectOnly([0]);
  await s.call(); await until(() => expect(s.announce).toHaveBeenCalled());
  expect(s.sends()).toHaveLength(1);
  expect(s.facts.some(f => f.stage === "completed")).toBe(false);
});

it("une erreur de transport donne unknown sans renvoi ni lancement du suivant", async () => {
  const s = await setup(); const original = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? Promise.reject(new Error("secret prompt")) : original(args));
  await s.call(); await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  expect(s.sends()).toHaveLength(1);
  expect(JSON.stringify(s.facts)).not.toContain("secret prompt");
});

it.each(["stop", "cancel"])("%s arrête la file sans interrompre l'agent", async action => {
  const s = await setup(); const ac = new AbortController();
  await s.call({ signal: ac.signal }); await until(() => expect(s.sends()).toHaveLength(1));
  if (action === "stop") await s.k.stopAll();
  if (action === "cancel") await s.k.tools.call("orca_annuler_envoi", { plan: s.facts[0]!.planId });
  await until(() => expect(s.facts.filter(f => f.stage === "cancelled")).toHaveLength(4));
  expect(s.sends()).toHaveLength(1); expect(s.sends()[0]).not.toContain("--interrupt");
  if (action === "cancel") expect((await s.k.tools.call("orca_envois", {})).text).toContain("dernière étape : entrée acceptée");
});

it("les conversations isolent statut et annulation ; arguments, diagnostics et fichier masquent la consigne", async () => {
  const s = await setup(); s.selectOnly([0]);
  await s.call({ origin: "body", session: "one" });
  await until(() => expect(s.sends()).toHaveLength(1));
  expect((await s.k.tools.call("orca_envois", {}, { origin: "body", session: "two" })).text).not.toContain("Alice");
  expect((await s.k.tools.call("orca_annuler_envoi", { plan: s.facts[0]!.planId }, { origin: "body", session: "two" })).status).toBe("failed");
  const all = JSON.stringify(s.k.audit.tail(100)) + JSON.stringify(s.facts) + readFileSync(join(s.home, "orca-deliveries.json"), "utf8");
  expect(all).not.toContain("Commit your work");
});

it("redémarrage : résumés de 48h, cap 20, aucune consigne rejouée", async () => {
  const home = mkdtempSync(join(tmpdir(), "orca-group-history-"));
  const old = { id: "old", owner: '["",""]', at: Date.now() - 49 * 3600_000, recipients: [{ label: "Old", stage: "queued" }] };
  const recent = Array.from({ length: 25 }, (_, i) => ({ ...old, id: `plan-${i}`, at: Date.now(), recipients: [{ label: `Agent-${i}`, stage: "input_accepted" }] }));
  writeFileSync(join(home, "orca-deliveries.json"), JSON.stringify([old, ...recent]));
  const s = await setup({ home });
  const r = await s.k.tools.call("orca_envois", {});
  expect(r.text).not.toContain("Old"); expect(r.text).not.toContain("Agent-0 :"); expect(r.text).toContain("Agent-24"); expect(r.text).toContain("aucun renvoi");
  expect(s.sends()).toHaveLength(0);
});

it("lit les reçus réels imbriqués et les hôtes anciens", () => {
  expect(receiptOf({ send: { accepted: true, prompt: { requestId: "durable", stages: ["input_accepted", "turn_started"] } } })).toEqual({ stage: "turn_started", requestId: "durable" });
  expect(receiptOf({ send: { accepted: true, prompt: { requestId: "unsupported-old-host", stages: ["input_accepted"], provider: "old-host" } } })).toEqual({ stage: "input_accepted", requestId: undefined });
});

it("deux accords simultanés gardent leurs destinataires et messages respectifs", async () => {
  const s = await setup({ autoApprove: false });
  s.selectOnly([0]);
  const a = s.k.tools.call("orca_envoyer_groupe", { message: "Instruction Alice" }, { session: "a" });
  await until(() => expect(s.approvals).toHaveLength(1));
  s.selectOnly([1]);
  const b = s.k.tools.call("orca_envoyer_groupe", { message: "Instruction Bob" }, { session: "b" });
  await until(() => expect(s.approvals).toHaveLength(2));
  expect(s.sends()).toHaveLength(0);
  expect(s.approvals[0]!.summary).toContain("Alice"); expect(s.approvals[0]!.summary).not.toContain("Bob");
  expect(s.approvals[1]!.summary).toContain("Bob"); expect(s.approvals[1]!.summary).not.toContain("Alice");
  s.k.approvals.respond(s.approvals[1]!.id, true, "test"); await b;
  s.k.approvals.respond(s.approvals[0]!.id, true, "test"); await a;
  await until(() => expect(s.sends()).toHaveLength(1));
  expect(s.sends()[0]).toEqual(["terminal", "send", "--terminal", "term_b", "--text", "Instruction Bob", "--enter"]);
  s.wts[0]!.agents![1]!.state = "working";
  await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "turn_started")).toBe(true));
  s.wts[0]!.agents![1]!.state = "done";
  await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends()[1]).toEqual(["terminal", "send", "--terminal", "term_a", "--text", "Instruction Alice", "--enter"]);
  expect(s.select.mock.calls[0]![2].session).toBe("a"); expect(s.select.mock.calls[1]![2].session).toBe("b");
});

it("un refus collectif n'atteint aucun terminal et laisse une trace sans consigne", async () => {
  const s = await setup({ autoApprove: false });
  const pending = s.call(); await until(() => expect(s.approvals).toHaveLength(1));
  s.k.approvals.respond(s.approvals[0]!.id, false, "test");
  expect((await pending).status).toBe("refused"); expect(s.sends()).toHaveLength(0);
  expect(s.facts.filter(f => f.stage === "refused")).toHaveLength(4);
});

it("un terminal avec le même handle et une nouvelle incarnation est refusé", async () => {
  const s = await setup(); s.selectOnly([0]);
  (s.terms[0] as unknown as Record<string, unknown>).processIncarnation = "old";
  s.k.bus.on("approval.request", () => { (s.terms[0] as unknown as Record<string, unknown>).processIncarnation = "new"; });
  await s.call(); await until(() => expect(s.facts.some(f => f.stage === "skipped" && f.reason === "terminal-replaced")).toBe(true));
  expect(s.sends()).toHaveLength(0);
});

it("un reçu turn_started seul ne prend pas l'ancien done pour la fin du nouveau tour", async () => {
  const s = await setup({ timeoutMs: 25, receipt: { send: { accepted: true, prompt: { requestId: "id", stages: ["input_accepted", "turn_started"] } } } });
  await s.call(); await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  expect(s.facts.some(f => f.stage === "completed")).toBe(false);
  expect(s.sends()).toHaveLength(1);
});

it("le plan reste dans raw et le bilan parlé nomme les tâches sans UUID, chemin ni consigne", async () => {
  const requestId = "12345678-1234-1234-1234-123456789abc";
  const s = await setup({ timeoutMs: 25, receipt: { send: { accepted: true, prompt: { requestId, stages: ["input_accepted"] } } } });
  s.wts[0]!.repo = "Floppy"; s.wts[0]!.displayName = "assistant";
  s.selectOnly([0]);
  const result = await s.call({ session: "private-session", turn: "private-turn" });
  const raw = result.raw as { planId: string };
  expect(raw.planId).toMatch(/^[a-f0-9-]{36}$/);
  await until(() => expect(s.announce).toHaveBeenCalledTimes(1));
  const status = await s.k.tools.call("orca_envois", {}, { session: "private-session" });
  const spoken = result.text + status.text + JSON.stringify(s.announce.mock.calls);
  for (const secret of [raw.planId, requestId, "C:/shared", "r::", "t:a", "Commit your work", "orca_envois", "orca_envoyer"]) expect(spoken).not.toContain(secret);
  expect(spoken).toContain("Needs commit"); expect(spoken).toContain("Floppy");
  const audit = s.k.audit.tail(200).filter(row => row.kind === "orca.delivery");
  const text = JSON.stringify(audit);
  for (const secret of [raw.planId, requestId, "C:/shared", "r::", "t:a", "Commit your work", "private-session", "private-turn"]) expect(text).not.toContain(secret);
  expect(audit.some(row => row.agentHash && row.callHash && row.sessionHash && row.turnHash && row.planHash)).toBe(true);
  expect(s.facts.some(row => row.worktreeId === "r::C:/shared" && row.session === "private-session" && row.requestId === requestId)).toBe(true);
});

it("un résolveur de nom stable reste humain et conserve le projet", async () => {
  const s = await setup({ label: () => "Tâche des mails 12345678-1234-1234-1234-123456789abc C:/private/work" });
  s.wts[0]!.repo = "Floppy"; s.wts[0]!.displayName = "assistant"; s.selectOnly([0]);
  const result = await s.call();
  expect(result.text).toContain("Tâche des mails"); expect(result.text).toContain("Floppy");
  expect(s.approvals[0]!.summary).not.toContain("12345678"); expect(s.approvals[0]!.summary).not.toContain("C:/private");
});

it.each(["read", "write"])("échec de persistance %s : diagnostic borné sans exception, chemin ou consigne", async operation => {
  const write = vi.fn(() => { if (operation === "write") throw new Error("C:/private/full instruction"); });
  const s = await setup({ timeoutMs: 25, persistence: {
    read: () => { if (operation === "read") throw new Error("C:/private/full instruction"); return undefined; },
    write,
  } });
  s.selectOnly([0]); await s.call();
  await until(() => expect(s.announce).toHaveBeenCalled());
  expect(s.problems).toEqual([{ reason: `${operation}-failed`, at: expect.any(Number) }]);
  expect(JSON.stringify(s.k.audit.tail(100).filter(row => row.kind === "orca.delivery.persistence"))).not.toContain("C:/private");
  expect(JSON.stringify(s.problems)).not.toContain("instruction");
  if (operation === "read") expect(write).not.toHaveBeenCalled();
});

it("l'accord d'annulation nomme les tâches et conserve les identifiants uniquement dans raw", async () => {
  const s = await setup(); s.selectOnly([0]);
  const queued = await s.call();
  const planId = (queued.raw as { planId: string }).planId;
  const cancelled = await s.k.tools.call("orca_annuler_envoi", { plan: planId });
  expect(cancelled.status).toBe("done"); expect((cancelled.raw as { planId: string }).planId).toBe(planId);
  expect(s.approvals[1]!.summary).toContain("Needs commit");
  expect(s.approvals[1]!.summary).not.toContain(planId); expect(cancelled.text).not.toContain(planId);
  const toolRows = s.k.audit.tail(100).filter(row => row.kind === "tool");
  expect(JSON.stringify(toolRows)).not.toContain(planId);
});

it("une fin courte identifiée et plus récente libère le dossier sans voir working", async () => {
  const s = await setup({ receipt: { send: { accepted: true, prompt: { requestId: "durable", stages: ["input_accepted", "turn_started"] } } } });
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() - 1000; a.turnEndDisposition = "identified";
  await s.call(); await until(() => expect(s.sends()).toHaveLength(1));
  a.turnEndedAt = Date.now() + 1;
  await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.facts.some(f => f.paneKey === "t:a" && f.stage === "completed" && f.observedState === "done")).toBe(true);
});

it.each(["stale", "ambiguous", "accepted-only"])("fin courte %s : ne libère pas le dossier sans preuve attribuable", async scenario => {
  const s = await setup({ timeoutMs: 25, receipt: { send: { accepted: true, prompt: { requestId: "durable", stages: scenario === "accepted-only" ? ["input_accepted"] : ["input_accepted", "turn_started"] } } } });
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() - 1000; a.turnEndDisposition = "identified";
  await s.call(); await until(() => expect(s.sends()).toHaveLength(1));
  if (scenario !== "stale") a.turnEndedAt = Date.now() + 1;
  if (scenario === "ambiguous") a.turnEndDisposition = "ambiguous";
  await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  expect(s.sends()).toHaveLength(1); expect(s.facts.some(f => f.stage === "completed")).toBe(false);
});


it("une interruption vocale après mise en file ne touche plus le plan approuvé", async () => {
  const s = await setup(); s.selectOnly([0, 1]);
  const ac = new AbortController();
  await s.call({ signal: ac.signal }); ac.abort();
  await until(() => expect(s.sends()).toHaveLength(1));
  s.wts[0]!.agents![0]!.state = "working";
  await until(() => expect(s.facts.some(f => f.stage === "turn_started")).toBe(true));
  s.wts[0]!.agents![0]!.state = "done";
  await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.facts.some(f => f.stage === "cancelled")).toBe(false);
});

it.each(["before", "approval"])("abandon %s avant engagement : aucun envoi", async when => {
  const s = await setup({ autoApprove: false }); const ac = new AbortController();
  if (when === "before") ac.abort();
  const call = s.call({ signal: ac.signal });
  if (when === "approval") { await until(() => expect(s.approvals).toHaveLength(1)); ac.abort(); }
  expect((await call).status).not.toBe("done");
  expect(s.sends()).toHaveLength(0); expect(s.facts.some(f => f.stage === "queued")).toBe(false);
});

it.each(["timeout", "unknown", "cancel"])("réconciliation %s : une fin attribuable libère seulement un nouveau plan", async scenario => {
  const s = await setup({ timeoutMs: 25, receipt: { send: { accepted: true, prompt: { requestId: "durable", stages: ["turn_started"] } } } });
  s.selectOnly([0]);
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() - 1000; a.turnEndDisposition = "identified";
  const first = await s.call(); await until(() => expect(s.facts.some(f => f.stage === "turn_started")).toBe(true));
  if (scenario === "cancel") await s.k.tools.call("orca_annuler_envoi", { plan: (first.raw as { planId: string }).planId });
  else if (scenario === "unknown") { const old = s.terms.splice(0); await until(() => expect(s.facts.some(f => f.stage === "unknown")).toBe(true)); s.terms.push(...old); }
  else await until(() => expect(s.facts.some(f => f.stage === "timeout")).toBe(true));
  s.selectOnly([1]);
  await s.call(); await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true));
  a.turnEndedAt = Date.now() + 1;
  await s.call(); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends().map(args => args[3])).toEqual(["term_a", "term_b"]);
  const releases = s.k.audit.tail(300).filter(row => row.kind === "orca.delivery.lock-release");
  expect(releases).toHaveLength(1); expect(releases[0]!.reason).toBe("attributable-turn-end");
  expect(JSON.stringify(releases)).not.toContain("r::C:/shared");
});

it.each(["absent", "partial", "idle", "stale", "ambiguous", "session", "terminal"])("incertitude %s : le dossier reste bloqué sans preuve exacte", async scenario => {
  const s = await setup({ timeoutMs: 25, receipt: { send: { accepted: true, prompt: { requestId: "durable", stages: ["turn_started"] } } } });
  s.selectOnly([0]);
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() - 1000; a.turnEndDisposition = "identified";
  await s.call(); await until(() => expect(s.facts.some(f => f.stage === "timeout")).toBe(true));
  s.selectOnly([1]);
  if (scenario === "absent") s.wts[0]!.agents!.shift();
  if (scenario === "partial") s.wts[0]!.agents = [s.wts[0]!.agents![1]!];
  if (scenario === "session") a.sessionId = "replacement";
  if (scenario === "terminal") s.terms[0]!.handle = "term_replacement";
  if (["absent", "partial", "session", "terminal", "ambiguous"].includes(scenario)) a.turnEndedAt = Date.now() + 1;
  if (scenario === "ambiguous") a.turnEndDisposition = "ambiguous";
  if (scenario === "idle") { a.state = "idle"; delete a.turnEndedAt; }
  await s.call(); await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true));
  expect(s.sends()).toHaveLength(1);
  expect(s.k.audit.tail(300).some(row => row.kind === "orca.delivery.lock-release")).toBe(false);
});

it("transport inconnu : une vraie transition observée après délai suffit, sans rejouer la file différée", async () => {
  const s = await setup({ receipt: {} });
  await s.call(); await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(3));
  s.selectOnly([1]); s.wts[0]!.agents![0]!.state = "working";
  await s.call(); await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(4));
  s.wts[0]!.agents![0]!.state = "idle";
  await s.call(); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends()[1]![3]).toBe("term_b");
  expect(s.k.audit.tail(300).find(row => row.kind === "orca.delivery.lock-release")!.reason).toBe("observed-working-to-idle");
});

it("une annulation concurrente au transport garde le verrou jusqu'au reçu tardif puis une preuve fraîche", async () => {
  const s = await setup(); s.selectOnly([0]);
  let resolve!: (value: unknown) => void;
  const late = new Promise<unknown>(r => { resolve = r; });
  const original = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" && args[3] === "term_a" ? late : original(args));
  const first = await s.call(); await until(() => expect(s.sends()).toHaveLength(1));
  await Promise.all([s.k.tools.call("orca_annuler_envoi", { plan: (first.raw as { planId: string }).planId }), s.k.tools.call("orca_annuler_envoi", { plan: (first.raw as { planId: string }).planId })]);
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  s.selectOnly([1]); await s.call();
  expect(s.sends()).toHaveLength(1);
  resolve({ send: { accepted: true, prompt: { requestId: "late", stages: ["turn_started"] } } });
  await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true));
  await s.call(); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.facts.filter(f => f.paneKey === "t:a" && f.stage === "cancelled")).toHaveLength(1);
  expect(s.facts.some(f => f.paneKey === "t:a" && f.stage === "turn_started")).toBe(false);
});

it("une preuve de verrou survit à l'éviction du plan parmi vingt résumés", async () => {
  const s = await setup({ receipt: { send: { accepted: true, prompt: { requestId: "durable", stages: ["turn_started"] } } } }); s.selectOnly([0]);
  const first = await s.call(); await until(() => expect(s.facts.some(f => f.stage === "turn_started")).toBe(true));
  await s.k.tools.call("orca_annuler_envoi", { plan: (first.raw as { planId: string }).planId });
  s.selectOnly([1]);
  for (let i = 0; i < 21; i++) { await s.call(); await until(() => expect(s.facts.filter(f => f.paneKey === "t:b" && f.stage === "deferred")).toHaveLength(i + 1)); }
  const status = await s.k.tools.call("orca_envois", {});
  expect(JSON.stringify(status.raw)).not.toContain((first.raw as { planId: string }).planId);
  const a = s.wts[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  await s.call(); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends()[1]![3]).toBe("term_b");
});


it("annuler pendant la revalidation avant transport empêche l'envoi et libère le dossier non utilisé", async () => {
  const s = await setup(); s.selectOnly([0]);
  const first = await s.call();
  let resolve!: (value: unknown) => void;
  const listing = new Promise<unknown>(r => { resolve = r; });
  const original = s.cli.getMockImplementation()!;
  s.cli.mockImplementationOnce(() => listing);
  await until(() => expect(s.cli.mock.calls.filter(([args]) => args[1] === "list")).toHaveLength(2));
  await s.k.tools.call("orca_annuler_envoi", { plan: (first.raw as { planId: string }).planId });
  resolve({ terminals: s.terms });
  s.cli.mockImplementation(original);
  s.selectOnly([1]); await s.call();
  await until(() => expect(s.sends()).toHaveLength(1));
  expect(s.sends()[0]![3]).toBe("term_b");
  expect(s.facts.some(f => f.paneKey === "t:a" && f.reason === "cancelled-before-send")).toBe(true);
});
