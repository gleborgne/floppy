import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, Kernel } from "@floppy/core";
import type { MemoryCorrection, MemoryCorrectionInput, MemoryService, VocabularyService } from "@floppy/contracts";
import vocabulary, { containsFragment, isExplicitCorrection } from "../src/index.ts";
import localMemory from "../../../memory/local/src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const k of kernels.splice(0)) await k.stopAll(); });
const scope = { domain: "m365.teams", account: "contoso", container: "engineering" };
const correction = { heard: "court team", canonical: "Core Team", scope, evidence: { text: "Non, je dis Core Team" } };
function mockMemory(initial: MemoryCorrection[] = []): MemoryService {
  let rows = [...initial];
  return {
    snapshot: () => ({ user: "", memory: "" }), record: () => {}, search: () => [],
    corrections: async () => structuredClone(rows),
    saveCorrection: async (input: MemoryCorrectionInput) => {
      const row = { ...structuredClone(input), id: `c${rows.length + 1}`, createdAt: "2026-01-01", updatedAt: "2026-01-01", version: 1 };
      rows.push(row); return row;
    },
    forgetCorrection: async (id) => { const old = rows.length; rows = rows.filter((r) => r.id !== id); return rows.length < old; },
  };
}

async function start(options: { memory?: MemoryService; local?: boolean; automatic?: boolean; write?: "always" | "never" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "vocabulary-"));
  let service!: VocabularyService;
  const provider = definePlugin({ manifest: { id: "test-memory", version: "0", licence: "MIT", provides: ["memory"] }, apply(ctx) { ctx.provide("memory", options.memory ?? mockMemory()); } });
  const probe = definePlugin({ manifest: { id: "probe-vocabulary", version: "0", licence: "MIT", inject: ["vocabulary"] }, apply(ctx) { service = ctx.get("vocabulary"); } });
  const k = new Kernel({ home, logger: () => {}, plugins: [options.local ? localMemory : provider, vocabulary, probe] });
  kernels.push(k);
  await k.applyConfig({
    approvals: { write: options.write ?? "ask", delete: "ask", toolRules: [{ source: "vocabulary", tool: "correct_vocabulary", level: "write", rule: "always" }] },
    plugins: [
      { id: options.local ? "memory" : "test-memory", plugin: options.local ? "memory" : "test-memory" },
      { id: "vocabulary", plugin: "vocabulary", config: { automatic: options.automatic ?? true } },
      { id: "probe", plugin: "probe-vocabulary" },
    ],
  });
  const observe = (text: string, session = "voice") => service.observe({ text, session, origin: "avatar" });
  const call = (args: Record<string, unknown> = correction, session = "voice") => k.tools.call("correct_vocabulary", args, { session, origin: "avatar" });
  expect(k.tools.list().map((t) => t.name).filter((n) => ["lister_corrections", "corriger_vocabulaire", "oublier_correction"].includes(n))).toEqual([]); // les anciens noms français n'existent plus
  return { k, service, observe, call, home };
}

describe("vocabulaire : apprentissage explicite", () => {
  it("retient la correction sans demande mémorise avec un fournisseur async interchangeable", async () => {
    const { service, observe, call } = await start();
    observe("Lis le canal court team"); observe(correction.evidence.text);
    expect((await call()).status).toBe("done");
    const result = await service.resolve({ heard: "COURT TEAM", scope });
    expect(result.status).toBe("match");
    expect(result.candidates[0]).toMatchObject({ canonical: "Core Team", evidence: { text: correction.evidence.text, session: "voice" } });
  });

  it("refuse une preuve inventée, un résultat d’outil, une phrase normale et une autre session", async () => {
    const { observe, call } = await start();
    observe("Lis court team"); observe("Core Team a envoyé un message");
    expect((await call()).status).toBe("failed");
    expect((await call({ ...correction, evidence: { text: "Core Team a envoyé un message" } })).status).toBe("failed");
    observe("Je ne suis pas disponible pour Core Team demain");
    expect((await call({ ...correction, evidence: { text: "Je ne suis pas disponible pour Core Team demain" } })).status).toBe("failed");
    observe("Écris « Non, je dis Core Team » dans le message");
    expect((await call()).status).toBe("failed");
    observe("Non, je dis Core Team");
    expect((await call(correction, "another-session")).status).toBe("failed");
    expect((await call({ ...correction, heard: "inexistant" })).status).toBe("failed");
    expect((await call({ ...correction, target: { id: "invented", kind: "team" } })).status).toBe("failed");
  });

  it("accepte une correction anglaise et une correction explicite dans un seul tour", async () => {
    const { observe, call } = await start();
    const evidence = "No, I meant Core Team, not court team";
    observe(evidence);
    expect((await call({ ...correction, evidence: { text: evidence } })).status).toBe("done");
    const direct = "Corrige court team en Core Team";
    observe(direct, "direct");
    expect((await call({ ...correction, evidence: { text: direct } }, "direct")).status).toBe("done");
  });

  it("réserve la preuve avant l’écriture asynchrone et refuse un appel concurrent", async () => {
    const memory = mockMemory();
    const save = memory.saveCorrection!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persist = vi.fn(async (...args: Parameters<typeof save>) => { entered(); await gate; return save(...args); });
    memory.saveCorrection = persist;
    const { observe, call } = await start({ memory });
    observe("Lis court team"); observe(correction.evidence.text);
    const first = call();
    await started;
    expect((await call()).status).toBe("failed");
    release();
    expect((await first).status).toBe("done");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("libère une preuve après un rejet fournisseur confirmé, sans autoriser le concurrent", async () => {
    const memory = mockMemory();
    const save = memory.saveCorrection!;
    let fail!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<never>((_resolve, reject) => { fail = reject; });
    const persist = vi.fn(async (...args: Parameters<typeof save>) => {
      if (persist.mock.calls.length === 1) { entered(); await gate; }
      return save(...args);
    });
    memory.saveCorrection = persist;
    const { observe, call } = await start({ memory });
    observe("Lis court team"); observe(correction.evidence.text);
    const first = call();
    await started;
    expect((await call()).status).toBe("failed");
    fail(new Error("refus du fournisseur"));
    expect((await first).status).toBe("failed");
    expect((await call()).status).toBe("done");
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("garde la preuve réservée après timeout lorsque l’écriture peut encore aboutir", async () => {
    const memory = mockMemory();
    const save = memory.saveCorrection!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persist = vi.fn(async (...args: Parameters<typeof save>) => { await gate; return save(...args); });
    memory.saveCorrection = persist;
    const { observe, call, service } = await start({ memory });
    observe("Lis court team"); observe(correction.evidence.text);
    expect((await call()).status).toBe("failed");
    expect((await call()).status).toBe("failed");
    release();
    await vi.waitFor(async () => expect((await service.resolve({ heard: correction.heard, scope })).status).toBe("match"));
    expect((await call()).status).toBe("failed");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("exige l’ancien fragment au tour précédent sauf pour une paire explicite", async () => {
    const { observe, call } = await start();
    observe(correction.evidence.text);
    expect((await call({ ...correction, heard: "non" })).status).toBe("failed");
    expect((await call()).status).toBe("failed");
    for (const evidence of ["Corrige court team en Core Team", "Pas court team mais Core Team", "Not court team but Core Team"]) {
      observe(evidence, evidence);
      expect((await call({ ...correction, evidence: { text: evidence } }, evidence)).status).toBe("done");
    }
  });

  it("ne transforme pas un changement d’avis ambigu en correction durable", async () => {
    const { observe, call } = await start();
    const cases = [
      ["Envoie à Bob", "Non, Alice", "Bob", "Alice"],
      ["Send to Bob", "I mean Alice", "Bob", "Alice"],
      ["Send to Bob", "No, I meant Alice", "Bob", "Alice"],
      ["Envoie à Bob", "Je veux dire Alice", "Bob", "Alice"],
      ["It is today", "No, it is tomorrow", "today", "tomorrow"],
      ["C’est aujourd’hui", "Non, c’est demain", "aujourd’hui", "demain"],
    ];
    for (const [previous, evidence, heard, canonical] of cases) {
      observe(previous!); observe(evidence!);
      expect((await call({ ...correction, heard, canonical, evidence: { text: evidence } })).status).toBe("failed");
    }
    observe("Read court team"); observe("No, I said Core Team");
    expect((await call({ ...correction, evidence: { text: "No, I said Core Team" } })).status).toBe("done");
  });

  it("rejette une preuve périmée ou provenant d’un autre corps", async () => {
    const { k, observe, call } = await start();
    observe("Lis court team"); observe(correction.evidence.text);
    expect((await k.tools.call("correct_vocabulary", correction, { session: "voice", origin: "telegram" })).status).toBe("failed");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    expect((await call()).status).toBe("failed");
  });

  it("respecte un refus et le réglage qui impose un accord", async () => {
    const { k, observe, call, service } = await start({ automatic: false });
    observe("Lis court team"); observe(correction.evidence.text);
    const pending = new Promise<void>((resolve) => k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, false, "test"); resolve(); }));
    const result = call();
    await pending;
    expect((await result).status).toBe("refused");
    expect((await service.resolve({ heard: correction.heard, scope })).status).toBe("none");
  });

  it("ne contourne pas une interdiction write", async () => {
    const { observe, call } = await start({ write: "never" });
    observe("Lis court team"); observe(correction.evidence.text);
    expect((await call()).status).toBe("refused");
  });

  it("conserve dans la mémoire locale après arrêt et redémarrage du plugin", async () => {
    const { k, observe, call, home } = await start({ local: true });
    observe("Lis court team"); observe(correction.evidence.text);
    expect((await call()).status).toBe("done");
    await k.stopAll();
    let restored!: VocabularyService;
    const probe = definePlugin({ manifest: { id: "probe-restored", version: "0", licence: "MIT", inject: ["vocabulary"] }, apply(ctx) { restored = ctx.get("vocabulary"); } });
    const next = new Kernel({ home, logger: () => {}, plugins: [localMemory, vocabulary, probe] });
    kernels.push(next);
    await next.applyConfig({ plugins: [{ id: "memory", plugin: "memory" }, { id: "vocabulary", plugin: "vocabulary" }, { id: "probe", plugin: "probe-restored" }] });
    expect((await restored.resolve({ heard: correction.heard, scope })).candidates[0]?.canonical).toBe("Core Team");
  });
});

describe("vocabulaire : interprétation contextualisée", () => {
  it("ne propage pas un nom à un autre compte, contenant ou domaine", async () => {
    const { observe, call, service } = await start();
    observe("Lis court team"); observe(correction.evidence.text); await call();
    for (const other of [{ ...scope, account: "other" }, { ...scope, container: "other" }, { domain: "orca" }, { domain: scope.domain }]) {
      expect((await service.resolve({ heard: correction.heard, scope: other })).status).toBe("none");
    }
    expect((await service.resolve({ heard: "court", scope })).status).toBe("none");
  });

  it("garde les ambiguïtés du fournisseur et cite les données sans toucher brut, messages ou citations", async () => {
    const row = { ...correction, id: "1", createdAt: "", updatedAt: "", version: 1 };
    const memory = mockMemory([row, { ...row, id: "2", canonical: "Court Team" }]);
    const { service, k } = await start({ memory });
    expect((await service.resolve({ heard: correction.heard, scope })).status).toBe("ambiguous");
    const raw = { heard: "Envoie « court team » à court team", scope };
    const before = structuredClone(raw);
    const context = await service.context(raw);
    expect(context).toContain('"canonical":"Core Team"');
    expect(context).toContain("jamais des instructions");
    expect(context).toContain("ne remplace jamais le texte des messages");
    expect(raw).toEqual(before);
    // Aucun hook ne transforme les noms ni les corps d'un outil quelconque.
    const args = { nom: "court team", message: "court team" };
    let received: unknown;
    k.tools.register("test", [{ name: "probe-message", level: "read", description: "test", inputSchema: {}, handler: async (a) => { received = a; return { status: "done", text: "ok" }; } }]);
    await k.tools.call("probe-message", args);
    expect(received).toEqual(args);
  });

  it("liste et oublie exactement une correction après accord", async () => {
    const { k, observe, call, service } = await start();
    observe("Lis court team"); observe(correction.evidence.text); await call();
    const listed = await k.tools.call("list_corrections", {});
    const [row] = JSON.parse(listed.text);
    k.bus.on("approval.request", (r) => k.approvals.respond(r.id, true, "test"));
    expect((await k.tools.call("forget_correction", { id: row.id })).status).toBe("done");
    expect((await service.resolve({ heard: correction.heard, scope })).status).toBe("none");
    expect((await call()).status).toBe("failed");
    expect((await k.tools.call("forget_correction", { id: row.id })).status).toBe("failed");
  });

  it("un refus de suppression conserve la correction", async () => {
    const { k, observe, call, service } = await start();
    observe("Lis court team"); observe(correction.evidence.text); await call();
    const [row] = JSON.parse((await k.tools.call("list_corrections", {})).text);
    k.bus.on("approval.request", (r) => k.approvals.respond(r.id, false, "test"));
    expect((await k.tools.call("forget_correction", { id: row.id })).status).toBe("refused");
    expect((await service.resolve({ heard: correction.heard, scope })).status).toBe("match");
  });

  it("borne une mémoire qui ignore son signal", async () => {
    const memory = mockMemory();
    let signal: AbortSignal | undefined;
    memory.corrections = (_q, options) => { signal = options?.signal; return new Promise(() => {}); };
    const { service, k } = await start({ memory });
    vi.useFakeTimers();
    const result = service.context().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2001);
    // AbortSignal.timeout utilise son horloge native ; le délai reste borné même si le fournisseur ignore le signal.
    vi.useRealTimers();
    expect(await result).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    expect(k.audit.tail(100).find((r) => r.kind === "vocabulary" && r.event === "provider.error")).toMatchObject({ operation: "corrections", reason: "timeout" });
  });

  it("ne reconnaît que des fragments entiers", () => {
    expect(containsFragment("Le score team", "core team")).toBe(false);
    expect(containsFragment("Le court team !", "COURT TEAM")).toBe(true);
    expect(containsFragment(" court team ", "")).toBe(false);
    expect(isExplicitCorrection("Non, c’est Core Team", "court team", "Core Team")).toBe(false);
    expect(isExplicitCorrection("Not court team but Core Team", "court team", "Core Team")).toBe(true);
    expect(isExplicitCorrection("Non, Core Team", "court team", "Core Team")).toBe(false);
    expect(isExplicitCorrection("Not available for Core Team", "court team", "Core Team")).toBe(false);
    expect(isExplicitCorrection("Non, je ne suis pas disponible pour Core Team", "court team", "Core Team")).toBe(false);
    expect(isExplicitCorrection("C’est Core Team qui attend", "court team", "Core Team")).toBe(false);
  });

  it("signale un fournisseur historique sans corrections", async () => {
    const { k } = await start({ memory: { snapshot: () => ({ user: "", memory: "" }), record: () => {}, search: () => [] } });
    expect((await k.tools.call("list_corrections", {})).text).toContain("ne prend pas en charge");
  });
});

describe("vocabulaire : audit", () => {
  const events = (k: Kernel) => k.audit.tail(1000).filter((r) => r.kind === "vocabulary");

  it("corrèle proposition, acceptation, sélection, résolution et oubli sans texte personnel", async () => {
    const { k, service } = await start();
    service.observe({ text: "Lis court team", session: "voice", origin: "avatar", turn: "t1" });
    service.observe({ text: correction.evidence.text, session: "voice", origin: "avatar", turn: "t2" });
    const meta = { session: "voice", origin: "avatar", turn: "t2" };
    expect((await k.tools.call("correct_vocabulary", correction, meta)).status).toBe("done");
    await service.context({ heard: "court team", ...meta });
    await service.resolve({ heard: "court team", scope, ...meta });
    await service.resolve({ heard: "unknown", scope, ...meta });
    const records = events(k);
    const proposed = records.find((r) => r.event === "correction.proposed")!;
    const accepted = records.find((r) => r.event === "correction.accepted")!;
    expect(accepted).toMatchObject({ session: "voice", origin: "avatar", turn: "t2", callId: proposed.callId, id: "c1", version: 1 });
    expect(proposed.callId).toEqual(expect.any(String));
    expect(records.find((r) => r.event === "context.selected")).toMatchObject({ count: 1, availableCount: 1, truncated: false, candidates: [{ id: "c1", version: 1, hasAccount: true, hasContainer: true, scopeId: expect.any(String) }] });
    expect(records.filter((r) => r.event === "resolution.completed").map((r) => r.status)).toEqual(["match", "none"]);
    k.bus.on("approval.request", (r) => k.approvals.respond(r.id, true, "test"));
    expect((await k.tools.call("forget_correction", { id: "c1" }, meta)).status).toBe("done");
    expect(events(k).find((r) => r.event === "correction.forgotten")).toMatchObject({ id: "c1", ...meta });
    const serialized = JSON.stringify(k.audit.tail(1000));
    for (const personal of [correction.heard, correction.canonical, correction.evidence.text, scope.account, scope.container]) expect(serialized).not.toContain(personal);
  });

  it("documente les refus de preuve et les décisions du noyau", async () => {
    const { k, observe, call } = await start();
    await call();
    observe("Lis court team"); observe("Je ne suis pas disponible pour Core Team");
    await call({ ...correction, evidence: { text: "Je ne suis pas disponible pour Core Team" } });
    await call(correction);
    expect(events(k).filter((r) => r.event === "correction.rejected").map((r) => r.reason)).toEqual(["missing-observation", "not-explicit-correction", "evidence-mismatch"]);
    const forbidden = await start({ write: "never" });
    await forbidden.call();
    expect(events(forbidden.k).find((r) => r.event === "correction.rejected")).toMatchObject({ reason: "kernel-refused" });
    expect(forbidden.k.audit.tail(100).find((r) => r.kind === "approval" && r.tool === "correct_vocabulary")).toMatchObject({ ok: false, reason: "policy-never" });
    expect(forbidden.k.audit.tail(100).find((r) => r.kind === "tool" && r.tool === "correct_vocabulary")).toMatchObject({ status: "refused", args: { redacted: true } });
  });

  it("donne une raison déterministe à chaque protection de preuve", async () => {
    const cases = [
      { reason: "origin-mismatch", meta: { origin: "elsewhere" } },
      { reason: "turn-mismatch", meta: { turn: "old-turn" } },
      { reason: "session-mismatch", args: { evidence: { text: correction.evidence.text, session: "other" } } },
      { reason: "canonical-missing", args: { canonical: "Other Name" } },
      { reason: "heard-unobserved", args: { heard: "unobserved" } },
      { reason: "unchanged-name", args: { heard: "Core Team" } },
      { reason: "invalid-input", args: { target: { id: "invented", kind: "team" } } },
    ];
    for (const entry of cases) {
      const { k, service } = await start();
      service.observe({ text: "Lis court team", session: "voice", origin: "avatar", turn: "t1" });
      service.observe({ text: correction.evidence.text, session: "voice", origin: "avatar", turn: "t2" });
      await k.tools.call("correct_vocabulary", { ...correction, ...entry.args }, { session: "voice", origin: "avatar", turn: "t2", ...entry.meta });
      expect(events(k).findLast((r) => r.event === "correction.rejected")?.reason).toBe(entry.reason);
    }
    const { k, observe, call } = await start();
    observe("Lis court team"); observe(correction.evidence.text);
    await call(); await call();
    expect(events(k).findLast((r) => r.event === "correction.rejected")?.reason).toBe("evidence-consumed");
  });

  it("documente ambiguïtés et erreurs fournisseur sans message d’erreur personnel", async () => {
    const row = { ...correction, id: "1", createdAt: "", updatedAt: "", version: 1 };
    const memory = mockMemory([row, { ...row, id: "2", canonical: "Court Team" }]);
    const { k, service, observe, call } = await start({ memory });
    await service.resolve({ heard: "court team", scope, session: "voice", turn: "t1" });
    expect(events(k).find((r) => r.event === "resolution.completed")).toMatchObject({ status: "ambiguous", count: 2 });
    memory.saveCorrection = () => { throw new Error("SECRET canonical personnel"); };
    observe("Lis court team"); observe(correction.evidence.text);
    expect((await call()).status).toBe("failed");
    expect(events(k).find((r) => r.event === "provider.error")).toMatchObject({ operation: "saveCorrection", reason: "provider-error", session: "voice", callId: expect.any(String) });
    expect(events(k).find((r) => r.event === "correction.rejected")).toMatchObject({ reason: "execution-error" });
    expect(JSON.stringify(k.audit.tail(1000))).not.toContain("SECRET");
  });

  it("active les extraits seulement sur choix explicite et arrête immédiatement après désactivation", async () => {
    const { k, observe, call } = await start();
    expect(k.settings.list().find((r) => r.key === "vocabulary.trace_text")).toMatchObject({ value: false, risk: "cli" });
    expect((await k.settings.change("vocabulary.trace_text", true, "voice")).ok).toBe(false);
    expect((await k.settings.change("vocabulary.trace_text", true, "ui")).ok).toBe(true);
    observe("Lis court team"); observe(correction.evidence.text); await call();
    const traces = events(k).filter((r) => r.event === "correction.trace");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ heard: correction.heard, canonical: correction.canonical, evidence: correction.evidence.text, evidenceTruncated: false });
    expect((await k.settings.change("vocabulary.trace_text", false, "ui")).ok).toBe(true);
    await call();
    expect(events(k).filter((r) => r.event === "correction.trace")).toHaveLength(1);
  });

  it("borne le texte de diagnostic à la correction courante", async () => {
    const { k, observe, call } = await start();
    await k.settings.change("vocabulary.trace_text", true, "ui");
    observe("Ancien message privé : lis court team");
    const evidence = `Non, je dis Core Team ${"x".repeat(1200)}`;
    observe(evidence);
    await call({ ...correction, evidence: { text: evidence } });
    const trace = events(k).find((r) => r.event === "correction.trace")!;
    expect(trace.evidence).toHaveLength(1000);
    expect(trace.evidenceTruncated).toBe(true);
    expect(JSON.stringify(trace)).not.toContain("Ancien message privé");
  });

  it("transmet les identifiants d’audit et annule le fournisseur avec le contexte", async () => {
    const memory = mockMemory();
    const seen: unknown[] = [];
    memory.corrections = (_query, options) => { seen.push(options); return []; };
    const { k, service } = await start({ memory });
    const meta = { session: "voice", origin: "avatar", turn: "turn42" };
    await service.context(meta);
    expect(seen[0]).toMatchObject(meta);
    const controller = new AbortController(); controller.abort();
    await expect(service.context({ ...meta, signal: controller.signal })).rejects.toBeInstanceOf(Error);
    expect(events(k).find((r) => r.event === "provider.error")).toMatchObject({ reason: "cancelled", ...meta });
  });

  it("accepte le préfixe d’activation configuré et conserve la preuve brute", async () => {
    const { service, observe, call } = await start();
    observe("Floppy lis court team");
    const evidence = "Floppy, non, je dis Core Team";
    observe(evidence);
    expect((await call({ ...correction, evidence: { text: evidence } })).status).toBe("done");
    expect((await service.resolve({ heard: "court team", scope })).candidates[0]?.evidence.text).toBe(evidence);
  });
});
