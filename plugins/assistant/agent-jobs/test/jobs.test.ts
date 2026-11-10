import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemoryAudit, definePlugin, T, TextError, writeJsonAtomic, type Context } from "@floppy/core";
import type { AgentRunInput } from "@floppy/contracts";
import { offerAgent } from "@floppy/agent-cli";
import jobs from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

async function start(opts: { approve?: boolean; maxConcurrent?: number; home?: string; duplicate?: boolean } = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "agent-jobs-"));
  const received: AgentRunInput[] = []; const notices: unknown[] = []; const documents: string[] = [];
  let consumer: Context | undefined;
  const provider = definePlugin({ manifest: { id: "test-agent", version: "0", licence: "MIT", provides: ["agent"] }, apply(ctx) {
    consumer = ctx;
    offerAgent(ctx, { id: "test", label: "Agent test", program: "node", aliases: ["essai"], args: (p) => [p] }, {
      exe: () => process.execPath, run: (f) => async function* (input) {
        received.push(input);
        if (input.text === "HANG") await new Promise<void>((ok) => { input.signal!.addEventListener("abort", () => ok(), { once: true }); });
        input.signal?.throwIfAborted();
        if (input.text === "FAIL") throw new TextError(T("Échec simulé.", "Simulated failure."));
        if (input.text === "WRITE") await f.tools.call("ecrire", {}, { origin: input.origin, signal: input.signal });
        yield { type: "text", delta: "résultat" };
        yield { type: "done", text: `résultat ${input.model ?? "défaut"}` };
      },
    });
  } });
  const docs = definePlugin({ manifest: { id: "test-docs", version: "0", licence: "MIT", provides: ["documents"] }, apply(ctx) {
    ctx.provide("documents", {
      async save(doc) { documents.push(doc.markdown); return { id: "doc", title: doc.title, date: "date", source: doc.source, tags: [] }; },
      async show() { return undefined; }, async list() { return []; }, async get() { return undefined; },
    });
  } });
  const audit = new MemoryAudit();
  const k = new Kernel({ home, audit, logger: () => {}, plugins: [provider, jobs, docs] }); kernels.push(k);
  k.bus.on("approval.request", (a) => k.approvals.respond(a.id, opts.approve ?? true, "test"));
  k.bus.on("initiative", (n) => { notices.push(n); });
  let writes = 0;
  k.tools.register("test", [{ name: "ecrire", description: "écrire", inputSchema: { type: "object", properties: {} }, level: "write",
    handler: async () => { writes++; return { status: "done", text: "fait" }; } }]);
  await k.applyConfig({ plugins: [
    { id: "a", plugin: "test-agent" }, ...(opts.duplicate ? [{ id: "b", plugin: "test-agent" }] : []),
    { id: "docs", plugin: "test-docs" }, { id: "jobs", plugin: "agent-jobs", config: { maxConcurrent: opts.maxConcurrent ?? 3 } },
  ] });
  const list = async () => JSON.parse((await k.tools.call("travaux_agents", {})).text) as { id: string; state: string; document?: string }[];
  return { k, home, received, notices, documents, list, consumer: () => consumer!, writes: () => writes };
}

describe("missions nommées et suivies", () => {
  it("découverte dynamique, alias et modèle ponctuel ; origine conservée ; écriture reste soumise à accord", async () => {
    const b = await start();
    expect(JSON.parse((await b.k.tools.call("lister_agents", {})).text)).toContainEqual(expect.objectContaining({ id: "a/test", delegation: true, tracked: true }));
    const r = await b.k.tools.call("deleguer_agent", { agent: "essai", modele: "provider/opus", consigne: "WRITE" }, { origin: "avatar" });
    expect(r).toMatchObject({ status: "done", text: "résultat provider/opus" });
    expect(b.received[0]).toMatchObject({ model: "provider/opus", origin: "avatar" });
    expect(b.writes()).toBe(1);
    expect(b.k.settings.list().filter((s) => s.key.includes("slot.brain"))).toEqual([]);
  });

  it("accord refusé : aucun agent emprunté et aucune mission exécutée", async () => {
    const b = await start({ approve: false });
    const r = await b.k.tools.call("lancer_travail_agent", { agent: "test", consigne: "x" });
    expect(r.status).toBe("refused"); expect(b.received).toEqual([]); expect(await b.list()).toEqual([]);
  });

  it("travail rendu immédiatement puis résultat durable, document et notification", async () => {
    const b = await start();
    const r = await b.k.tools.call("lancer_travail_agent", { agent: "a/test", consigne: "rapport", modele: "opus" });
    expect(r.status).toBe("done");
    await vi.waitFor(async () => expect((await b.list())[0]!.state).toBe("done"));
    const job = (await b.list())[0]!;
    expect(job.document).toBe("doc"); expect(b.documents).toEqual(["résultat opus"]); expect(b.notices).toHaveLength(1);
    const result = JSON.parse((await b.k.tools.call("travaux_agents", { id: job.id })).text);
    expect(result).toMatchObject({ instruction: "rapport", result: "résultat opus", state: "done" });
    expect(JSON.parse(readFileSync(join(b.home, "workspaces", "agent-jobs", "jobs.json"), "utf8"))[0]).toMatchObject({ state: "done" });
  });

  it("limite de concurrence, annulation et échec n'annoncent jamais un succès", async () => {
    const b = await start({ maxConcurrent: 1 });
    await b.k.tools.call("lancer_travail_agent", { agent: "test", consigne: "HANG" });
    expect((await b.k.tools.call("lancer_travail_agent", { agent: "test", consigne: "x" })).status).toBe("failed");
    const id = (await b.list())[0]!.id;
    await b.k.tools.call("arreter_travail_agent", { id });
    await vi.waitFor(async () => expect((await b.list())[0]!.state).toBe("cancelled"));
    await b.k.tools.call("lancer_travail_agent", { agent: "test", consigne: "FAIL" });
    await vi.waitFor(async () => expect((await b.list())[1]!.state).toBe("failed"));
    expect(b.documents).toEqual([]);
  });

  it("deux profils du même agent : nom ambigu refusé, identifiant complet accepté", async () => {
    const b = await start({ duplicate: true });
    expect((await b.k.tools.call("deleguer_agent", { agent: "test", consigne: "x" })).status).toBe("failed");
    expect((await b.k.tools.call("deleguer_agent", { agent: "a/test", consigne: "x" })).status).toBe("done");
    expect(b.received).toHaveLength(1);
  });

  it("une mission laissée en cours après un arrêt brutal devient interrompue sans être rejouée", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-recover-"));
    writeJsonAtomic(join(home, "workspaces", "agent-jobs", "jobs.json"), [{ id: "old", agent: "a/test", instruction: "x", state: "running", started: "date" }]);
    const b = await start({ home });
    expect(await b.list()).toContainEqual(expect.objectContaining({ id: "old", state: "interrupted" }));
    expect(b.received).toEqual([]);
  });
});
