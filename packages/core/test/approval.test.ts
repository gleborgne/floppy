import { describe, it, expect, vi } from "vitest";
import { Kernel, strictest, MemoryAudit } from "../src/index.ts";

const quiet = () => {};

describe("Accords", () => {
  it("la règle la plus stricte gagne", () => {
    expect(strictest("always", "ask")).toBe("ask");
    expect(strictest("ask", "never", "always")).toBe("never");
    expect(strictest(undefined, "always")).toBe("always");
  });

  it("read = libre, write = demande, override never = refus sans demande", async () => {
    const audit = new MemoryAudit();
    const k = new Kernel({ logger: quiet, audit });
    const asked: unknown[] = [];
    k.bus.on("approval.request", (r) => asked.push(r));
    expect(await k.approvals.check({ tool: "lire", args: {}, level: "read", summary: "" })).toMatchObject({ ok: true, reason: "policy-always" });
    expect(await k.approvals.check({ tool: "ecrire", args: {}, level: "read", summary: "", override: "never" })).toMatchObject({ ok: false, reason: "policy-never" });
    expect(asked).toHaveLength(0);
    expect(audit.records.map((r) => r.ok)).toEqual([true, false]);
  });

  it("une réponse du corps débloque l'outil ; une 2e réponse est ignorée", async () => {
    const k = new Kernel({ logger: quiet });
    const closed: unknown[] = [];
    k.bus.on("approval.closed", (c) => closed.push(c));
    k.bus.on("approval.request", (r) => {
      expect(k.approvals.respond(r.id, true, "avatar")).toBe(true);
      expect(k.approvals.respond(r.id, false, "telegram")).toBe(false);
    });
    const d = await k.approvals.check({ tool: "open_url", args: { url: "https://x" }, level: "write", summary: "Ouvrir x ?" });
    expect(d).toEqual({ ok: true, reason: "user", by: "avatar" });
    expect(closed).toEqual([expect.objectContaining({ ok: true, by: "avatar" })]);
  });

  it("pas de réponse = refus après le délai", async () => {
    vi.useFakeTimers();
    try {
      const k = new Kernel({ logger: quiet });
      await k.applyConfig({ approvals: { timeout_s: 90 } });
      const p = k.approvals.check({ tool: "envoyer", args: {}, level: "send", summary: "" });
      await vi.advanceTimersByTimeAsync(90_001);
      expect(await p).toMatchObject({ ok: false, reason: "timeout" });
      expect(k.approvals.pending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopAll refuse les demandes en cours", async () => {
    const k = new Kernel({ logger: quiet });
    const p = k.approvals.check({ tool: "supprimer", args: {}, level: "delete", summary: "" });
    await k.stopAll();
    expect(await p).toMatchObject({ ok: false, reason: "cancelled" });
  });
});
