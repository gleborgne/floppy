import { afterEach, describe, expect, it } from "vitest";
import { Kernel, MemoryAudit } from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });

describe("observabilité des outils", () => {
  it("relie accord et résultat avec un identifiant noyau sans recopier les données personnelles", async () => {
    const audit = new MemoryAudit();
    const k = new Kernel({ audit, logger: () => {} }); kernels.push(k);
    await k.applyConfig({ approvals: { toolRules: [{ source: "memory", tool: "correction", level: "write", rule: "always" }] } });
    let metaReceived: unknown;
    k.tools.register("memory", [{
      name: "correction", description: "test", level: "write", inputSchema: {},
      auditArgs: () => ({ candidateCount: 1 }),
      summary: () => "Nom personnel dans la demande visible",
      handler: async (_args, meta) => { metaReceived = meta; return { status: "failed", text: "Erreur personnelle : secret-detail" }; },
    }]);
    const out = await k.tools.call("correction", { evidence: "texte-personnel", canonical: "nom-personnel" }, { session: "s1", turn: "t1", origin: "avatar", callId: "fourni-par-appelant" });
    expect(out.text).toContain("secret-detail"); // L'utilisateur conserve les détails, le journal est réduit.
    const approval = audit.records.find(r => r.kind === "approval")!;
    const tool = audit.records.find(r => r.kind === "tool")!;
    expect(approval).toMatchObject({ session: "s1", turn: "t1", source: "memory" });
    expect(tool).toMatchObject({ session: "s1", turn: "t1", args: { candidateCount: 1 }, error: "tool-failed" });
    expect(approval.callId).toBe(tool.callId);
    expect(tool.callId).not.toBe("fourni-par-appelant");
    expect(metaReceived).toMatchObject({ callId: tool.callId, session: "s1", turn: "t1" });
    expect(JSON.stringify(audit.records)).not.toMatch(/texte-personnel|nom-personnel|secret-detail/);
  });

  it("un filtre défaillant masque les paramètres, et un refus reste auditable sans exécuter", async () => {
    const audit = new MemoryAudit();
    const k = new Kernel({ audit, logger: () => {} }); kernels.push(k);
    let reached = false;
    k.tools.register("memory", [{
      name: "oublier", level: "delete", description: "test", inputSchema: {},
      auditArgs() { throw new Error("filtre cassé"); },
      handler: async () => { reached = true; return { status: "done", text: "fait" }; },
    }]);
    k.bus.on("approval.request", r => k.approvals.respond(r.id, false, "test"));
    expect((await k.tools.call("oublier", { secret: "personnel" }, { session: "s", turn: "t" })).status).toBe("refused");
    expect(reached).toBe(false);
    const tool = audit.records.find(r => r.kind === "tool")!;
    const approval = audit.records.find(r => r.kind === "approval")!;
    expect(tool.args).toEqual({ redacted: true });
    expect(tool.callId).toBe(approval.callId);
    expect(approval.reason).toBe("user");
    expect(JSON.stringify(audit.records)).not.toContain("personnel");
  });
});
