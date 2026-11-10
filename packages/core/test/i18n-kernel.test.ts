// Messages du noyau en anglais : erreurs des plugins (interface), refus et outils internes (assistant).
import { describe, it, expect } from "vitest";
import { Kernel, definePlugin, T, TextError, tr } from "../src/index.ts";

const broken = definePlugin({
  manifest: { id: "casse", version: "0", licence: "MIT" },
  apply() { throw new TextError(T("disque plein", "disk full")); },
});

const risky = definePlugin({
  manifest: { id: "risque", version: "0", licence: "MIT" },
  apply(ctx) {
    let v = false;
    ctx.settings.declare([{
      key: "partage", section: "general", label: T("Partage", "Sharing"), description: "", type: "boolean", risk: "ask",
      get: () => v, set: (x) => { v = Boolean(x); },
    }]);
    ctx.tools.register([{ name: "effacer", description: "", inputSchema: { type: "object" }, level: "delete", handler: async () => ({ status: "done", text: "ok" }) }]);
  },
});

describe("noyau bilingue", () => {
  it("l'erreur d'un plugin suit la langue de l'interface", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [broken] });
    await k.applyConfig({ plugins: [{ id: "c", plugin: "casse" }, { id: "x", plugin: "inconnu" }] });
    expect(k.status().find((s) => s.id === "c")?.error).toBe("apply a échoué : disque plein");
    await k.settings.change("langue_interface", "en", "ui");
    expect(k.status().find((s) => s.id === "c")?.error).toBe("apply failed: disk full");
    expect(k.status().find((s) => s.id === "x")?.error).toBe("unknown plugin: inconnu");
    await k.stopAll();
  });

  it("refus et outils internes dans la langue de l'assistant", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [risky] });
    await k.applyConfig({ plugins: [{ id: "r", plugin: "risque" }], approvals: { delete: "never" } });
    await k.settings.change("langue_assistant", "en", "ui");
    await k.idle();
    expect((await k.tools.call("effacer", {})).text).toMatch(/^Action forbidden by the configuration/);
    expect((await k.tools.call("inexistant", {})).text).toBe("Unknown tool: inexistant");
    expect((await k.tools.call("lister_reglages", {})).text).toContain("partage");

    // Refus à la voix, en anglais : reconnu comme un refus (pas un échec).
    const call = k.tools.call("changer_reglage", { cle: "partage", valeur: "yes" });
    await new Promise((r) => setTimeout(r, 10));
    const req = k.approvals.pending()[0]!;
    expect(req.summary).toBe("Sharing: no → yes");
    k.approvals.respond(req.id, false, "test");
    const r = await call;
    expect(r).toMatchObject({ status: "refused" });
    expect(r.text).toMatch(/^Refused by the user/);
    await k.stopAll();
  });

  it("tâches : messages en français et en anglais", async () => {
    const k = new Kernel({ logger: () => {} });
    await k.applyConfig({ plugins: [] });
    const out = await k.tasks.run("rien/du-tout", "manual");
    expect(out.ok).toBe(false);
    expect(tr(out.text, "fr")).toBe("Tâche inconnue : rien/du-tout.");
    expect(tr(out.text, "en")).toBe("Unknown task: rien/du-tout.");
    await k.stopAll();
  });
});
