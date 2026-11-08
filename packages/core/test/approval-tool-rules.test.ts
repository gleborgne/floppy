import { afterEach, describe, expect, it } from "vitest";
import { Kernel, MemoryAudit, definePlugin, type Context } from "../src/index.ts";

const kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels.splice(0)) await k.stopAll(); });
const rule = { source: "vocabulary", tool: "corriger", level: "write" as const, rule: "always" as const };
const tool = (name: string, level: "write" | "send" | "delete" = "write") => ({
  name, level, description: "test", inputSchema: { type: "object" },
  handler: async () => ({ status: "done" as const, text: "fait" }),
});

describe("accords ciblés par fournisseur, outil et niveau", () => {
  it("autorise exactement la correction configurée et conserve les accords des autres actions", async () => {
    const audit = new MemoryAudit();
    const k = new Kernel({ logger: () => {}, audit }); kernels.push(k);
    await k.applyConfig({ approvals: { toolRules: [rule] } });
    const requested: string[] = [];
    k.bus.on("approval.request", r => { requested.push(r.tool); k.approvals.respond(r.id, false, "test"); });
    k.tools.register("vocabulary", [tool("corriger"), tool("autre"), tool("envoyer", "send"), tool("oublier", "delete")]);
    expect((await k.tools.call("corriger", {})).status).toBe("done");
    for (const name of ["autre", "envoyer", "oublier"]) expect((await k.tools.call(name, {})).status).toBe("refused");
    expect(requested).toEqual(["autre", "envoyer", "oublier"]);
    expect(audit.records.find(r => r.kind === "approval" && r.tool === "corriger")).toMatchObject({ source: "vocabulary", rule: "always", reason: "policy-always" });
  });

  it("un autre fournisseur ou un autre niveau ne réutilise pas l'autorisation", async () => {
    const k = new Kernel({ logger: () => {} }); kernels.push(k);
    await k.applyConfig({ approvals: { toolRules: [rule] } });
    k.bus.on("approval.request", r => k.approvals.respond(r.id, false, "test"));
    const remove = k.tools.register("imposteur", [tool("corriger")]);
    expect((await k.tools.call("corriger", { source: "vocabulary" })).status).toBe("refused");
    remove();
    k.tools.register("vocabulary", [tool("corriger", "send")]);
    expect((await k.tools.call("corriger", {})).status).toBe("refused");
  });

  it("un interdit global ou ciblé reste prioritaire ; le réglage du plugin peut redemander", async () => {
    const k = new Kernel({ logger: () => {} }); kernels.push(k);
    let ask = false, requests = 0;
    k.tools.register("vocabulary", [{ ...tool("corriger"), rule: () => ask ? "ask" : undefined }]);
    k.bus.on("approval.request", r => { requests++; k.approvals.respond(r.id, false, "test"); });
    await k.applyConfig({ approvals: { write: "never", toolRules: [rule] } });
    expect((await k.tools.call("corriger", {})).status).toBe("refused");
    expect(requests).toBe(0);
    await k.applyConfig({ approvals: { toolRules: [rule, { ...rule, rule: "never" }] } });
    expect((await k.tools.call("corriger", {})).status).toBe("refused");
    expect(requests).toBe(0);
    await k.applyConfig({ approvals: { toolRules: [rule] } });
    ask = true;
    expect((await k.tools.call("corriger", {})).status).toBe("refused");
    expect(requests).toBe(1);
    ask = false;
    expect((await k.tools.call("corriger", {})).status).toBe("done");
  });

  it("ctx.approvals fixe la source réelle et refuse un signal annulé même avec autorisation", async () => {
    let ctx!: Context;
    const plugin = definePlugin({ manifest: { id: "probe", version: "0", licence: "MIT" }, apply(c) { ctx = c; } });
    const k = new Kernel({ logger: () => {}, plugins: [plugin] }); kernels.push(k);
    await k.applyConfig({ plugins: [{ id: "probe", plugin: "probe" }], approvals: { toolRules: [rule] } });
    k.bus.on("approval.request", r => k.approvals.respond(r.id, false, "test"));
    expect(await ctx.approvals.check({ tool: "corriger", source: "vocabulary", level: "write", args: {}, summary: "" })).toMatchObject({ ok: false, reason: "user" });
    expect(await k.approvals.check({ tool: "corriger", source: "vocabulary", level: "write", args: {}, summary: "", signal: AbortSignal.abort() })).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
