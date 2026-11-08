import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, onCorruptFile, readJsonFile, writeJsonAtomic, type ToolCallMeta } from "@floppy/core";
import type { OrcaTerminal, OrcaWorktree } from "../src/index.ts";
import { sendTool } from "../src/send.ts";
import { groupSendTools } from "../src/group-send.ts";
import type { ProtectionStorage } from "../src/checkout-protection.ts";
import type { DeliveryFact } from "../src/send-support.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });
const until = async (test: () => void) => vi.waitFor(test, { interval: 5, timeout: 1500 });
const started = { send: { accepted: true, prompt: { requestId: "private-request", stages: ["turn_started"] } } };
async function setup(opts: { home?: string; receipt?: unknown; timeoutMs?: number; approve?: boolean; storage?: ProtectionStorage; reverse?: boolean } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "orca-protection-"));
  const rows: OrcaWorktree[] = [{ worktreeId: "repo::C:/shared", displayName: "Floppy", agents: [
    { paneKey: "t:a", agentType: "codex", displayName: "Alice", taskTitle: "Alice task", state: "done" },
    { paneKey: "t:b", agentType: "claude", displayName: "Bob", taskTitle: "Bob task", state: "done" },
  ] }, { worktreeId: "repo::C:/independent", displayName: "Other", agents: [
    { paneKey: "t:c", agentType: "codex", displayName: "Chloe", taskTitle: "Chloe task", state: "done" },
  ] }];
  const terms: OrcaTerminal[] = rows.flatMap(w => w.agents!.map(a => ({ worktreeId: w.worktreeId, handle: `term_${a.paneKey.split(":")[1]}`, tabId: "t", leafId: a.paneKey.split(":")[1] })));
  const cli = vi.fn(async (args: string[]): Promise<unknown> => args[1] === "list" ? { terminals: terms } : opts.receipt ?? started);
  const run = vi.fn(async () => rows);
  const facts: DeliveryFact[] = [];
  const k = new Kernel({ home, logger: () => {}, plugins: [definePlugin({ manifest: { id: "send-test", version: "1", licence: "MIT" }, apply(ctx) {
    const single = () => sendTool({ ctx, cli, run, direct: () => true, protection: { storage: opts.storage }, onDelivery: f => facts.push(f), target: (wts, name) => {
      for (const w of wts) for (const a of w.agents ?? []) if (a.displayName === name) return { w, a };
      return { status: "failed", text: "Agent absent" };
    } });
    const group = () => groupSendTools({ ctx, cli, run, direct: () => true, protection: { storage: opts.storage }, pollMs: 3, timeoutMs: opts.timeoutMs ?? 1000, onDelivery: f => facts.push(f), select: (wts, args) => wts.flatMap(w => (w.agents ?? []).filter(a => String(args.nom).split(",").includes(a.displayName!)).map(a => ({ w, a }))) });
    ctx.tools.register(opts.reverse ? [...group(), single()] : [single(), ...group()]);
  } })] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "test", plugin: "send-test" }] });
  const approvals: { id: string; summary: string }[] = [];
  k.bus.on("approval.request", e => { approvals.push(e); if (opts.approve !== false) k.approvals.respond(e.id, true, "test"); });
  const single = (name = "Bob", meta: ToolCallMeta = {}) => k.tools.call("orca_envoyer", { nom: name, message: "Private instruction do not persist" }, meta);
  const group = (name = "Alice,Bob", meta: ToolCallMeta = {}) => k.tools.call("orca_envoyer_groupe", { nom: name, message: "Private group instruction do not persist" }, meta);
  const sends = () => cli.mock.calls.filter(([a]) => a[1] === "send");
  const stateFile = join(home, "orca-checkout-protection.json");
  const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as { blocked: boolean; locks: Record<string, unknown>[] };
  return { k, home, rows, terms, cli, run, facts, approvals, single, group, sends, state, stateFile };
}

it.each(["active-other", "active-same", "uncertain-other", "uncertain-same"])("groupe vers individuel %s : aucun contournement du dossier", async scenario => {
  const s = await setup({ timeoutMs: scenario.startsWith("uncertain") ? 25 : 1000 });
  await s.group("Alice"); await until(() => expect(s.sends()).toHaveLength(1));
  if (scenario.startsWith("uncertain")) await until(() => expect(s.facts.some(f => f.stage === "timeout")).toBe(true));
  expect((await s.single(scenario.endsWith("same") ? "Alice" : "Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(1);
  expect(s.approvals.at(-1)!.summary).toContain("dossier en attente de preuve");
  expect(s.facts.at(-1)!.reason).toBe("checkout-unconfirmed");
});

it.each(["started", "unknown", "exception"])("individuel %s vers groupe et individuel : protection dans les deux sens", async receipt => {
  const s = await setup({ receipt: receipt === "unknown" ? {} : started, reverse: true });
  if (receipt === "exception") { const old = s.cli.getMockImplementation()!; s.cli.mockImplementation(args => args[1] === "send" ? Promise.reject(new Error("private transport error")) : old(args)); }
  await s.single("Alice");
  expect((await s.single("Bob")).status).toBe("failed");
  expect((await s.single("Alice")).status).toBe("failed");
  await s.group(); await until(() => expect(s.facts.filter(f => f.stage === "deferred")).toHaveLength(4));
  expect(s.sends()).toHaveLength(1);
});

it("un agent déjà au travail accepte une consigne en l'absence de conflit, puis le dossier est protégé", async () => {
  const s = await setup(); s.rows[0]!.agents![0]!.state = "working";
  expect((await s.single("Alice")).status).toBe("done");
  expect((await s.single("Alice")).status).toBe("failed");
  s.rows[0]!.agents![0]!.state = "idle";
  // La fin de l'ancien travail ne prouve pas la fin du nouveau message.
  expect((await s.single("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(1);
});

it.each(["single-single", "single-group"])("concurrence %s : un seul transport gagne atomiquement", async scenario => {
  const s = await setup();
  let resolve!: (value: unknown) => void;
  const late = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? late : old(args));
  const first = s.single("Alice");
  await until(() => expect(s.sends()).toHaveLength(1));
  if (scenario === "single-single") expect((await s.single("Bob")).status).toBe("failed");
  else { await s.group("Bob"); await until(() => expect(s.facts.some(f => f.stage === "deferred")).toBe(true)); }
  expect(s.sends()).toHaveLength(1);
  expect(s.state().locks[0]!.settled).toBe(false);
  resolve(started); await first;
  expect(s.sends()).toHaveLength(1);
});

it("deux accords individuels ouverts avant transport ne peuvent acquérir le même dossier", async () => {
  const s = await setup({ approve: false });
  const a = s.single("Alice"), b = s.single("Bob");
  await until(() => expect(s.approvals).toHaveLength(2));
  for (const approval of s.approvals) s.k.approvals.respond(approval.id, true, "test");
  const results = await Promise.all([a, b]);
  expect(results.map(r => r.status).sort()).toEqual(["done", "failed"]);
  expect(s.sends()).toHaveLength(1);
});

it("une observation suspendue de l'ancien envoi ne devient pas une preuve pour son successeur", async () => {
  const s = await setup(); await s.single("Alice");
  s.rows[0]!.agents![0]!.state = "working";
  s.run.mockImplementation(async () => structuredClone(s.rows));
  let resolve!: (value: unknown) => void;
  const listing = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!; let lists = 0;
  s.cli.mockImplementation(args => args[1] === "list" && ++lists === 2 ? listing : old(args));
  const stale = s.single("Bob");
  await until(() => expect(lists).toBeGreaterThanOrEqual(2));
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.state = "done"; a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  expect((await s.single("Alice")).status).toBe("done");
  resolve({ terminals: s.terms });
  expect((await stale).status).toBe("failed");
  expect(s.state().locks[0]!.observedWorking).toBe(false);
  expect((await s.single("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(2);
});

it("un destinataire différé pendant sa revalidation suspendue ne reprend pas quand le dossier est libéré", async () => {
  const s = await setup(); await s.single("Alice");
  await s.group("Bob");
  let resolve!: (value: unknown) => void;
  const listing = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!;
  const before = s.cli.mock.calls.length;
  s.cli.mockImplementationOnce(() => listing);
  await until(() => expect(s.cli.mock.calls.length).toBeGreaterThan(before));
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  s.cli.mockImplementation(old);
  await s.group("Alice");
  expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true);
  resolve({ terminals: s.terms });
  await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends().map(([args]) => args[3])).toEqual(["term_a", "term_a"]);
});

it("un agent redevenu actif pendant la lecture du terminal n'est pas traité comme déjà actif à la sélection", async () => {
  const s = await setup();
  let resolve!: (value: unknown) => void;
  const listing = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!; let lists = 0;
  s.cli.mockImplementation(args => args[1] === "list" && ++lists === 2 ? listing : old(args));
  const pending = s.single("Bob");
  await until(() => expect(lists).toBe(2));
  s.rows[0]!.agents![1]!.state = "working";
  resolve({ terminals: s.terms });
  expect((await pending).status).toBe("failed");
  expect(s.sends()).toHaveLength(0); expect(s.state().locks).toHaveLength(0);
});

it.each(["single", "group"])("le dossier changé après accord %s n'emprunte pas la protection de l'ancien dossier", async kind => {
  const s = await setup();
  s.k.bus.on("approval.request", () => { (s.rows[0] as unknown as Record<string, unknown>).checkoutPath = "C:/different-checkout"; });
  if (kind === "single") expect((await s.single("Alice")).status).toBe("failed");
  else { await s.group("Alice"); await until(() => expect(s.facts.some(f => f.stage === "skipped")).toBe(true)); }
  expect(s.sends()).toHaveLength(0); expect(s.state().locks).toHaveLength(0);
});

it("un groupe dont le transport attend son reçu bloque aussi l'individuel", async () => {
  const s = await setup();
  let resolve!: (v: unknown) => void;
  const pending = new Promise<unknown>(r => { resolve = r; });
  const old = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? pending : old(args));
  await s.group("Alice"); await until(() => expect(s.sends()).toHaveLength(1));
  expect((await s.single("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(1);
  resolve(started);
});

it("les factories dans des contextes distincts partagent le même registre et survivent à l'arrêt d'un propriétaire", async () => {
  const home = mkdtempSync(join(tmpdir(), "orca-shared-guard-"));
  const rows: OrcaWorktree[] = [{ worktreeId: "r::C:/shared", displayName: "Floppy", agents: [
    { paneKey: "t:a", state: "done", agentType: "codex", displayName: "Alice" },
    { paneKey: "t:b", state: "done", agentType: "claude", displayName: "Bob" },
  ] }];
  const terms: OrcaTerminal[] = ["a", "b"].map(leafId => ({ worktreeId: rows[0]!.worktreeId, tabId: "t", leafId, handle: `term_${leafId}` }));
  const cli = vi.fn(async (args: string[]): Promise<unknown> => args[1] === "list" ? { terminals: terms } : started);
  const run = async () => rows;
  const facts: DeliveryFact[] = [];
  const k = new Kernel({ home, logger: () => {}, plugins: [
    definePlugin({ manifest: { id: "one", version: "1", licence: "MIT" }, apply(ctx) { ctx.tools.register([sendTool({ ctx, cli, run, direct: () => true, target: () => ({ w: rows[0]!, a: rows[0]!.agents![0]! }) })]); } }),
    definePlugin({ manifest: { id: "many", version: "1", licence: "MIT" }, apply(ctx) { ctx.tools.register(groupSendTools({ ctx, cli, run, direct: () => true, pollMs: 3, onDelivery: f => facts.push(f), select: () => [{ w: rows[0]!, a: rows[0]!.agents![1]! }] })); } }),
  ] }); kernels.push(k);
  k.bus.on("approval.request", e => k.approvals.respond(e.id, true, "test"));
  await k.applyConfig({ plugins: [{ id: "one", plugin: "one" }, { id: "many", plugin: "many" }] });
  await k.tools.call("orca_envoyer", { nom: "Alice", message: "Private instruction" });
  await k.tools.call("orca_envoyer_groupe", { message: "Private group" });
  await until(() => expect(facts.some(f => f.stage === "deferred")).toBe(true));
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")).toHaveLength(1);
  await k.applyConfig({ plugins: [{ id: "one", plugin: "one", disabled: true }, { id: "many", plugin: "many" }] });
  const a = rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  await k.tools.call("orca_envoyer_groupe", { message: "New private group" });
  await until(() => expect(cli.mock.calls.filter(([a]) => a[1] === "send")).toHaveLength(2));
  expect(cli.mock.calls.filter(([a]) => a[1] === "send")[1]![0][3]).toBe("term_b");
});

it("les dossiers indépendants restent disponibles pendant un groupe actif", async () => {
  const s = await setup(); await s.group("Alice");
  await until(() => expect(s.sends()).toHaveLength(1));
  expect((await s.single("Chloe")).status).toBe("done");
  expect(s.sends()).toHaveLength(2); expect(s.state().locks).toHaveLength(2);
});

it("deux espaces portant des chemins équivalents partagent aussi la protection", async () => {
  const s = await setup();
  (s.rows[1] as unknown as Record<string, unknown>).checkoutPath = "c:\\SHARED\\";
  await s.single("Alice");
  expect((await s.single("Chloe")).status).toBe("failed");
  expect(s.sends()).toHaveLength(1);
});

it("une fin prouvée libère l'individuel pour un nouveau groupe, sans rejouer une ancienne file différée", async () => {
  const s = await setup(); await s.single("Alice");
  await s.group("Bob"); await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true));
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  await s.group("Bob"); await until(() => expect(s.sends()).toHaveLength(2));
  expect(s.sends().map(([args]) => args[3])).toEqual(["term_a", "term_b"]);
  expect(s.facts.filter(f => f.paneKey === "t:b" && f.stage === "sending")).toHaveLength(1);
});

it("une preuve d'un groupe expiré libérée par l'individuel ne rejoue pas les destinataires différés", async () => {
  const s = await setup({ timeoutMs: 25 }); await s.group();
  await until(() => expect(s.facts.some(f => f.paneKey === "t:b" && f.stage === "deferred")).toBe(true));
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  expect((await s.single("Alice")).status).toBe("done");
  expect(s.sends().map(([args]) => args[3])).toEqual(["term_a", "term_a"]);
});

it("un reçu inconnu est récupérable seulement après une transition observée, sans renvoi automatique", async () => {
  const s = await setup({ receipt: {} }); await s.single("Alice");
  s.rows[0]!.agents![0]!.state = "working";
  expect((await s.single("Bob")).status).toBe("failed");
  expect(s.state().locks[0]!.observedWorking).toBe(true);
  s.rows[0]!.agents![0]!.state = "idle";
  expect((await s.single("Bob")).status).toBe("unverified");
  expect(s.sends().map(([args]) => args[3])).toEqual(["term_a", "term_b"]);
});

it.each(["unknown", "timeout", "cancel"])("redémarrage après %s : aucune libération ni réémission implicite", async scenario => {
  const s = await setup({ receipt: scenario === "unknown" ? {} : started, timeoutMs: 25 });
  if (scenario === "unknown") await s.single("Alice");
  else { const result = await s.group("Alice"); await until(() => expect(s.sends()).toHaveLength(1));
    if (scenario === "cancel") await s.k.tools.call("orca_annuler_envoi", { plan: (result.raw as { planId: string }).planId });
    else await until(() => expect(s.facts.some(f => f.stage === "timeout")).toBe(true));
  }
  await s.k.stopAll();
  const next = await setup({ home: s.home });
  expect((await next.single("Bob")).status).toBe("failed");
  expect(next.sends()).toHaveLength(0); expect(next.state().locks).toHaveLength(1);
});

it("une fin attribuable après redémarrage libère le verrou conservé, sans rejouer le plan restauré", async () => {
  const s = await setup(); await s.single("Alice"); await s.k.stopAll();
  const next = await setup({ home: s.home });
  const a = next.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  await next.group("Bob"); await until(() => expect(next.sends()).toHaveLength(1));
  expect(next.sends()[0]![0][3]).toBe("term_b");
});

it("la transition réellement observée reste une preuve après redémarrage", async () => {
  const s = await setup({ receipt: {} }); await s.single("Alice");
  s.rows[0]!.agents![0]!.state = "working"; await s.single("Bob");
  await s.k.stopAll();
  const next = await setup({ home: s.home });
  expect((await next.single("Bob")).status).toBe("done");
  expect(next.sends()).toHaveLength(1);
});

it.each(["old", "absent", "partial", "empty", "session", "terminal", "idle", "stale", "ambiguous"])("restauration %s : aucun faux déverrouillage", async scenario => {
  const s = await setup(); await s.single("Alice"); await s.k.stopAll();
  if (scenario === "old") { const state = s.state(); state.locks[0]!.sentAt = Date.now() - 60 * 24 * 3600_000; writeFileSync(s.stateFile, JSON.stringify(state)); }
  const next = await setup({ home: s.home });
  const a = next.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  if (scenario === "absent") next.rows[0]!.agents!.shift();
  if (scenario === "partial") next.rows[0]!.agents = [next.rows[0]!.agents![1]!];
  if (scenario === "session") a.sessionId = "new-session";
  if (scenario === "terminal") next.terms[0]!.handle = "term_replaced";
  if (["session", "terminal", "ambiguous"].includes(scenario)) { a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified"; }
  if (scenario === "idle") a.state = "idle";
  if (scenario === "stale") { a.turnEndedAt = Date.now() - 1000; a.turnEndDisposition = "identified"; }
  if (scenario === "ambiguous") a.turnEndDisposition = "ambiguous";
  if (scenario === "empty") next.run.mockImplementationOnce(async () => next.rows).mockImplementationOnce(async () => []);
  expect((await next.single("Bob")).status).toBe("failed"); expect(next.sends()).toHaveLength(0);
  expect(next.state().locks).toHaveLength(1);
});

it("un transport interrompu sans reçu durable conserve une clôture après redémarrage même face à une fin apparente", async () => {
  const s = await setup(); let resolve!: (v: unknown) => void;
  const pending = new Promise<unknown>(r => { resolve = r; }); const old = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? pending : old(args));
  const first = s.single("Alice"); await until(() => expect(s.sends()).toHaveLength(1));
  await s.k.stopAll();
  const next = await setup({ home: s.home });
  const a = next.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  expect((await next.single("Bob")).status).toBe("failed");
  resolve(started); await first;
  expect((await next.single("Bob")).status).toBe("failed");
  expect(next.state().locks[0]!.settled).toBe(false); expect(next.sends()).toHaveLength(0);
});

it.each(["read", "write"])("panne %s : échec fermé avant transport et diagnostic sans chemin ni consigne", async failure => {
  const storage: ProtectionStorage = { read: () => { if (failure === "read") throw new Error("C:/secret/private instruction"); return undefined; }, write: () => { throw new Error("C:/secret/private instruction"); } };
  const s = await setup({ storage });
  expect((await s.single("Alice")).status).toBe("failed");
  expect((await s.group("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(0);
  const audit = s.k.audit.tail(100).filter(r => r.kind === "orca.delivery.protection");
  expect(audit).toHaveLength(1); expect(JSON.stringify(audit)).not.toContain("C:/secret"); expect(JSON.stringify(audit)).not.toContain("private instruction");
});

it.each(["receipt", "release"])("panne d'écriture %s après transport : protection conservée et aucun second transport", async failure => {
  let writes = 0;
  const storage: ProtectionStorage = { read: readJsonFile, write: (file, value) => { if (++writes === (failure === "receipt" ? 3 : 4)) throw new Error("disk full"); writeJsonAtomic(file, value); } };
  const s = await setup({ storage }); await s.single("Alice");
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  expect((await s.single("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(1); expect(s.state().locks).toHaveLength(1);
  if (failure === "receipt") expect(s.state().locks[0]!.settled).toBe(false);
});

it.each(["json", "empty", "schema", "duplicate", "hash", "time"])("protection corrompue %s : blocage persistant et aucun transport", async corrupt => {
  const s = await setup(); await s.single("Alice"); await s.k.stopAll();
  const state = s.state();
  if (corrupt === "schema") state.locks[0]!.unexpected = "private content";
  if (corrupt === "duplicate") state.locks.push(state.locks[0]!);
  if (corrupt === "hash") state.locks[0]!.checkout = "C:/private/path";
  if (corrupt === "time") state.locks[0]!.sentAt = -1;
  writeFileSync(s.stateFile, corrupt === "json" ? "{broken" : corrupt === "empty" ? "" : JSON.stringify(state));
  const previous = onCorruptFile(() => {});
  try {
    const next = await setup({ home: s.home });
    expect((await next.single("Bob")).status).toBe("failed"); expect(next.sends()).toHaveLength(0);
    await next.k.stopAll();
    const again = await setup({ home: s.home });
    expect((await again.single("Bob")).status).toBe("failed"); expect(again.sends()).toHaveLength(0);
  } finally { onCorruptFile(previous); }
});

it("l'état de sûreté ne garde que des hashes et preuves minimales ; sa libération ne laisse pas d'historique", async () => {
  const s = await setup(); await s.single("Alice");
  const encoded = readFileSync(s.stateFile, "utf8");
  for (const secret of ["Alice", "Bob", "private-request", "Private instruction", "Private group", "C:/shared", "repo::", "term_a", "t:a"]) expect(encoded).not.toContain(secret);
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  // Nouveau plan refusé par Orca : les deux verrous sont prouvés libérés, aucun historique gardé.
  const old = s.cli.getMockImplementation()!;
  s.cli.mockImplementation(args => args[1] === "send" ? Promise.resolve({ accepted: false }) : old(args));
  await s.single("Bob"); expect(s.state().locks).toHaveLength(0);
  const audit = JSON.stringify(s.k.audit.tail(200));
  for (const secret of ["Private instruction", "Private group", "C:/shared", "repo::", "term_a", "private-request"]) expect(audit).not.toContain(secret);
});

it("le préavis nomme uniquement les destinataires bloqués et ne libère rien avant l'accord", async () => {
  const s = await setup(); await s.single("Alice");
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  // Le premier listener est automatique ; bloquer les prochains accords avec une règle locale.
  const before = s.state().locks[0];
  s.k.bus.on("approval.request", e => { expect(s.state().locks[0]).toEqual(before); });
  await s.group("Bob,Chloe");
  const summary = s.approvals.at(-1)!.summary;
  expect(summary).toContain("Bob task"); expect(summary).toContain("dossier en attente de preuve");
  const chloeLine = summary.split("\n").find(line => line.includes("Chloe task"))!;
  expect(chloeLine).not.toContain("dossier en attente de preuve");
  await until(() => expect(s.sends()).toHaveLength(3));
});

it("un accord refusé laisse intacte une protection même si une preuve est devenue disponible", async () => {
  const s = await setup({ approve: false });
  const first = s.single("Alice"); await until(() => expect(s.approvals).toHaveLength(1));
  s.k.approvals.respond(s.approvals[0]!.id, true, "test"); await first;
  const before = s.state();
  const a = s.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  const next = s.group("Bob"); await until(() => expect(s.approvals).toHaveLength(2));
  expect(s.approvals[1]!.summary).toContain("dossier en attente de preuve");
  expect(s.state()).toEqual(before);
  s.k.approvals.respond(s.approvals[1]!.id, false, "test"); expect((await next).status).toBe("refused");
  expect(s.state()).toEqual(before); expect(s.sends()).toHaveLength(1);
});

it("la limite de 800 protections bloque explicitement les nouvelles sans évincer les anciennes", async () => {
  const s = await setup(); await s.single("Alice"); await s.k.stopAll();
  const state = s.state(), original = state.locks[0]!;
  state.locks.push(...Array.from({ length: 799 }, (_, i) => ({ ...original, checkout: i.toString(16).padStart(64, "0") })));
  writeFileSync(s.stateFile, JSON.stringify(state));
  const next = await setup({ home: s.home });
  const result = await next.single("Chloe");
  expect(result.status).toBe("failed"); expect(result.text).toContain("Limite");
  expect(next.facts.at(-1)!.reason).toBe("protection-capacity");
  expect(next.sends()).toHaveLength(0); expect(next.state().locks).toHaveLength(800);
  const a = next.rows[0]!.agents![0]! as unknown as Record<string, unknown>;
  a.turnEndedAt = Date.now() + 1; a.turnEndDisposition = "identified";
  // La libération reste possible à la capacité maximale ; aucun verrou ne doit expirer pour faire de la place.
  expect((await next.single("Bob")).status).toBe("done");
  expect(next.sends()).toHaveLength(1); expect(next.state().locks).toHaveLength(800);
});

it.each([{ legacy: [] }, { legacy: [{ id: "legacy", at: Date.now(), recipients: [{ stage: "timeout" }] }] }])("ancien résumé sans registre %j : migration fermée plutôt qu'un déverrouillage par redémarrage", async ({ legacy }) => {
  const home = mkdtempSync(join(tmpdir(), "orca-legacy-guard-"));
  writeFileSync(join(home, "orca-deliveries.json"), JSON.stringify(legacy));
  const s = await setup({ home });
  expect((await s.single("Alice")).status).toBe("failed");
  expect((await s.group("Bob")).status).toBe("failed");
  expect(s.sends()).toHaveLength(0); expect(s.state().blocked).toBe(true);
  expect(s.k.audit.tail(100).some(row => row.kind === "orca.delivery.protection" && row.reason === "legacy-state-without-protection")).toBe(true);
});
