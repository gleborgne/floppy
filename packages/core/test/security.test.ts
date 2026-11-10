import { describe, it, expect, vi } from "vitest";
import { Kernel, MemorySecrets, Bus, definePlugin, scopedSecrets, TextError, tr, type Context, type ItemInfo, type PluginDef } from "../src/index.ts";

const quiet = () => {};

/** Plugin espion : garde son ctx pour que les tests l'utilisent comme le ferait un plugin. */
function spy(id: string, permissions?: PluginDef["manifest"]["permissions"]) {
  const box: { ctx?: Context } = {};
  const def = definePlugin({
    manifest: { id, version: "0", licence: "MIT", ...(permissions ? { permissions } : {}) },
    apply(ctx) { box.ctx = ctx; },
  });
  return { box, def };
}

describe("1. accords : un plugin ne répond pas à sa propre demande", () => {
  it("sans permissions.approvals, respond et pending lèvent une erreur claire ; check reste permis", async () => {
    const s = spy("sans");
    const k = new Kernel({ logger: quiet, plugins: [s.def] });
    await k.applyConfig({ approvals: { timeout_s: 2 }, plugins: [{ id: "x", plugin: "sans" }] });
    expect(() => s.box.ctx!.approvals.respond("id", true, "x")).toThrow(/permissions\.approvals/);
    expect(() => s.box.ctx!.approvals.pending()).toThrow(/permissions\.approvals/);
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, true, "avatar"); });
    expect(await s.box.ctx!.approvals.check({ tool: "t", args: {}, level: "write", summary: "" })).toMatchObject({ ok: true, by: "avatar" });
    await k.stopAll();
  });

  it("avec permissions.approvals: respond, c'est permis ; le point de contrôle du noyau garde l'accès complet", async () => {
    const s = spy("avec", { approvals: "respond" });
    const k = new Kernel({ logger: quiet, plugins: [s.def] });
    await k.applyConfig({ approvals: { timeout_s: 2 }, plugins: [{ id: "x", plugin: "avec" }] });
    const p = s.box.ctx!.approvals.check({ tool: "t", args: {}, level: "write", summary: "" });
    const [req] = s.box.ctx!.approvals.pending();
    expect(req).toBeTruthy();
    expect(s.box.ctx!.approvals.respond(req!.id, true, "corps")).toBe(true);
    expect((await p).ok).toBe(true);
    expect(k.approvals.pending()).toHaveLength(0);
    await k.stopAll();
  });
});

describe("2. secrets cloisonnés", () => {
  it("un plugin ne lit, n'écrit et ne supprime que sous son préfixe ; les noms existants restent lisibles", async () => {
    const vault = new MemorySecrets();
    vault.set("autre/x/apiKey", "S");
    vault.set("llm-openai/m/apiKey", "K");
    const a = spy("llm-openai");
    const k = new Kernel({ logger: quiet, plugins: [a.def], secrets: vault });
    await k.applyConfig({ plugins: [{ id: "a", plugin: "llm-openai" }] });
    const s = a.box.ctx!.secrets;
    expect(s.get("llm-openai/m/apiKey")).toBe("K");
    s.set("llm-openai/n/apiKey", "N");
    expect(vault.get("llm-openai/n/apiKey")).toBe("N");
    expect(() => s.get("autre/x/apiKey")).toThrow(/refusé/);
    expect(() => s.has("autre/x/apiKey")).toThrow(/refusé/);
    expect(() => s.set("autre/x/apiKey", "pirate")).toThrow(/refusé/);
    expect(() => s.delete("autre/x/apiKey")).toThrow(/refusé/);
    expect(() => s.get("llm-openai/../autre/x/apiKey")).toThrow(/refusé/);
    expect(() => s.get("llm-openaiX/y")).toThrow(/refusé/);
    expect(vault.get("autre/x/apiKey")).toBe("S");
    await k.stopAll();
  });

  it("scopedSecrets refuse un nom vide après le préfixe", () => {
    expect(() => scopedSecrets(new MemorySecrets(), "p").get("p/")).toThrow(/refusé/);
  });
});

/** Plugin à réglages pour 3 et 4. */
function settingsPlugin() {
  return definePlugin({
    manifest: { id: "rp", version: "0", licence: "MIT" },
    apply(ctx) {
      let cloud = false, dossier = "aucun";
      ctx.settings.declare([
        { key: "cloud", section: "general", label: "Cloud", description: "", type: "boolean", risk: "ask", get: () => cloud, set: (v) => { cloud = Boolean(v); } },
        { key: "dossier", section: "general", label: "Dossier", description: "", type: "enum", risk: "cli",
          options: [{ value: "aucun", label: "aucun" }, { value: "docs", label: "docs" }], get: () => dossier, set: (v) => { dossier = String(v); } },
      ]);
    },
  });
}
async function bootSettings(approvals: Record<string, unknown> = {}) {
  const k = new Kernel({ logger: quiet, plugins: [settingsPlugin()] });
  await k.applyConfig({ approvals: { timeout_s: 2, ...approvals }, plugins: [{ id: "r", plugin: "rp" }] } as never);
  return k;
}

describe("3. annuler un réglage ne contourne pas le risque", () => {
  it("un réglage « cli » changé par la CLI ne s'annule pas à la voix", async () => {
    const k = await bootSettings();
    expect((await k.settings.change("dossier", "docs", "cli")).ok).toBe(true);
    const r = await k.tools.call("annuler_reglage", {});
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/CLI/);
    expect(k.settings.value("dossier")).toBe("docs");
    // Par la CLI, l'annulation passe (l'entrée était restée dans l'historique).
    expect((await k.settings.undo("cli")).ok).toBe(true);
    expect(k.settings.value("dossier")).toBe("aucun");
    await k.stopAll();
  });

  it("un réglage « ask » : l'annulation à la voix demande l'accord ; refusée, la valeur reste", async () => {
    const k = await bootSettings();
    expect((await k.settings.change("cloud", "oui", "cli")).ok).toBe(true);
    const asked: string[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r.summary); k.approvals.respond(r.id, false, "t"); });
    const r = await k.tools.call("annuler_reglage", {});
    expect(asked).toHaveLength(1);
    expect(r.text).toMatch(/Refusé/);
    expect(k.settings.value("cloud")).toBe(true);
    await k.stopAll();
  });

  it("accepté : l'annulation s'applique", async () => {
    const k = await bootSettings();
    await k.settings.change("cloud", "oui", "cli");
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, true, "t"); });
    expect((await k.tools.call("annuler_reglage", {})).status).toBe("done");
    expect(k.settings.value("cloud")).toBe(false);
    await k.stopAll();
  });
});

const itemStore: Record<string, ItemInfo> = {};
function itemsPlugin() {
  return definePlugin({
    manifest: { id: "ip", version: "0", licence: "MIT" },
    apply(ctx) {
      itemStore.cloud = { id: "cloud", label: "Nuage", enabled: false, cloud: true };
      itemStore.fixe = { id: "fixe", label: "Fixe", enabled: true, toggleable: false };
      itemStore.libre = { id: "libre", label: "Libre", enabled: true, toggleable: true };
      ctx.items.declare({
        id: "fake", section: "cerveau", label: "Faux", list: () => Object.values(itemStore),
        setEnabled: async (id, on) => { itemStore[id]!.enabled = on; return { ok: true, text: "" }; },
      });
    },
  });
}
async function bootItems(approvals: Record<string, unknown> = {}, extra: PluginDef<any>[] = []) {
  const k = new Kernel({ logger: quiet, plugins: [itemsPlugin(), ...extra] });
  await k.applyConfig({
    approvals: { timeout_s: 2, ...approvals },
    plugins: [{ id: "i", plugin: "ip" }, ...extra.map((d, n) => ({ id: `e${n}`, plugin: d.manifest.id }))],
  } as never);
  return k;
}

describe("4. cloud et « ask » demandent l'accord même avec approvals.write: always", () => {
  it("réglage « ask » à la voix", async () => {
    const k = await bootSettings({ write: "always" });
    const asked: unknown[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r); k.approvals.respond(r.id, false, "t"); });
    const r = await k.settings.change("cloud", "oui", "voice");
    expect(asked).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(k.settings.value("cloud")).toBe(false);
    await k.stopAll();
  });

  it("activer un élément cloud à la voix", async () => {
    const k = await bootItems({ write: "always" });
    const asked: unknown[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r); k.approvals.respond(r.id, false, "t"); });
    const r = await k.items.run({ op: "enable", provider: "fake", id: "cloud", on: true }, "voice");
    expect(asked).toHaveLength(1);
    expect(r.ok).toBe(false);
    await k.stopAll();
  });

  it("élément introuvable à l'activation par la voix : refusé, pas ignoré", async () => {
    const k = await bootItems({ write: "always" });
    const r = await k.items.run({ op: "enable", provider: "fake", id: "fantome", on: true }, "voice");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/introuvable/);
    await k.stopAll();
  });
});

describe("5. toggleable: false", () => {
  it("désactiver un élément non désactivable est refusé (voix et hôte) ; les autres passent", async () => {
    const k = await bootItems();
    for (const via of ["voice", "ui", "cli"] as const) {
      const r = await k.items.run({ op: "enable", provider: "fake", id: "fixe", on: false }, via);
      expect(r.ok).toBe(false);
      expect(itemStore.fixe!.enabled).toBe(true);
    }
    expect((await k.items.run({ op: "enable", provider: "fake", id: "libre", on: false }, "voice")).ok).toBe(true);
    await k.stopAll();
  });
});

describe("6. un plugin ne peut pas se dire « ui » ou « cli »", () => {
  it("via « ui »/« cli » venant d'un plugin est ramené à « assistant » ; « voice » reste restreint", async () => {
    const s = spy("ip2");
    const k = await bootItems({ write: "always" }, [s.def]);
    const audits: Record<string, unknown>[] = [];
    const orig = k.audit.write.bind(k.audit);
    k.audit.write = ((rec: Record<string, unknown>) => { audits.push(rec); return orig(rec as never); }) as never;
    // « voice » : les opérations autres que enable sont refusées
    expect((await s.box.ctx!.items.run({ op: "action", provider: "fake", id: "libre", action: "x" }, "voice")).ok).toBe(false);
    // « ui » forcé (contournement du typage) : pas le privilège « ui » (pas d'accord cloud sauté)
    const asked: unknown[] = [];
    k.bus.on("approval.request", (r) => { asked.push(r); k.approvals.respond(r.id, false, "t"); });
    await s.box.ctx!.items.run({ op: "enable", provider: "fake", id: "cloud", on: true }, "ui" as never);
    expect(asked).toHaveLength(1);
    expect(itemStore.cloud!.enabled).toBe(false);
    await s.box.ctx!.items.run({ op: "enable", provider: "fake", id: "libre", on: true }, "cli" as never);
    const cat = audits.filter((a) => a.kind === "catalog");
    expect(cat.length).toBeGreaterThan(0);
    expect(cat.every((a) => a.via === "assistant")).toBe(true);
    await k.stopAll();
  });
});

describe("7. bus : une promesse rejetée d'un abonné ne plante pas", () => {
  it("rejet asynchrone et exception synchrone sont attrapés ; les autres abonnés reçoivent l'événement", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const bus = new Bus();
    const got: unknown[] = [];
    bus.on("x", async () => { throw new Error("async"); });
    bus.on("x", () => { throw new Error("sync"); });
    bus.on("x", (p) => { got.push(p); });
    bus.emit("x", 1);
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(got).toEqual([1]);
    expect(unhandled).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

describe("8. lister_elements : rubriques dynamiques", () => {
  it("l'enum suit les rubriques du registre", async () => {
    const k = await bootItems();
    const tool = k.tools.list().find((t) => t.name === "lister_elements")!;
    expect(JSON.stringify(tool.inputSchema)).toContain("cerveau");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("avatars");
    await k.stopAll();
  });
});

describe("lot sécurité : événements du noyau et réseau", () => {
  it("un plugin ne peut pas imiter une demande d'accord ni l'état d'un plugin", async () => {
    const seen: string[] = [];
    let emitAll!: () => void;
    const p = definePlugin({
      manifest: { id: "p", version: "0", licence: "MIT" },
      apply(ctx) {
        emitAll = () => {
          ctx.emit("approval.request", { id: "faux", tool: "t", args: {}, level: "write", summary: "?", ttl_s: 9, expiresAt: 0 });
          ctx.emit("plugin.state", { id: "x", plugin: "x", state: "active" });
          ctx.emit("initiative", { source: "p", text: "permis", importance: "normal" });
        };
      },
    });
    const logs: string[] = [];
    const k = new Kernel({ logger: (r) => logs.push(r.msg), plugins: [p] });
    k.bus.on("approval.request", () => { seen.push("approval.request"); });
    k.bus.on("initiative", () => { seen.push("initiative"); });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    k.bus.on("plugin.state", (s) => { if (s.id === "x") seen.push("plugin.state"); });
    emitAll();
    expect(seen).toEqual(["initiative"]);
    expect(logs.filter((l) => l.includes("réservé au noyau"))).toHaveLength(2);
    await k.stopAll();
  });

  /** Un plugin « p » avec ces permissions, son ctx, le journal et l'audit du noyau. */
  async function netPlugin(net: string[] | undefined) {
    let ctx!: Context;
    const p = definePlugin({ manifest: { id: "p", version: "0", licence: "MIT", ...(net ? { permissions: { net } } : {}) }, apply(c) { ctx = c; } });
    const logs: string[] = [];
    const k = new Kernel({ logger: (r) => logs.push(r.msg), plugins: [p] });
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }] });
    return { ctx, logs, k, audit: k.audit as unknown as { records: { kind: string; plugin?: string; host?: string }[] } };
  }
  /** Ce qui sort sur un faux hôte (.invalid : le nom ne se résout jamais) n'est PAS un refus du noyau, mais une panne réseau. */
  const passed = async (c: Context, url: string) => {
    const err = await c.fetch(url, { timeoutMs: 2000 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(TextError);
  };

  it("ctx.fetch : la boucle locale est permise sans rien déclarer, le délai s'applique", async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => { if (req.url === "/lent") return; res.end("ok"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const { ctx, logs, k } = await netPlugin(["example.org"]);
    try {
      expect(await (await ctx.fetch(`${base}/a`)).text()).toBe("ok");
      await passed(ctx, "http://localhost:1/"); // pas de serveur : une panne réseau, pas un refus
      expect(logs.filter((l) => l.includes("refusé"))).toHaveLength(0);
      await expect(ctx.fetch(`${base}/lent`, { timeoutMs: 50 })).rejects.toThrow();
    } finally {
      await k.stopAll();
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("ctx.fetch : un hôte absent de permissions.net est refusé (TextError bilingue au nom du plugin), noté une fois", async () => {
    const { ctx, logs, k, audit } = await netPlugin(["example.org"]);
    try {
      for (const url of ["https://api.contoso.invalid/v1", "https://api.contoso.invalid/v2"]) {
        const err = await ctx.fetch(url).then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(TextError);
        const t = (err as TextError).text;
        expect(tr(t, "fr")).toBe("p : l'accès à api.contoso.invalid n'est pas permis (permissions.net du manifeste)");
        expect(tr(t, "en")).toBe("p: access to api.contoso.invalid is not allowed (manifest permissions.net)");
      }
      expect(logs.filter((l) => l.includes("api.contoso.invalid refusé"))).toHaveLength(1);
      expect(audit.records.filter((r) => r.kind === "plugin.net.refused")).toEqual([expect.objectContaining({ plugin: "p", host: "api.contoso.invalid" })]);
      // Sans permissions.net du tout : refusé aussi (sauf boucle locale).
      const none = await netPlugin(undefined);
      await expect(none.ctx.fetch("https://api.contoso.invalid/")).rejects.toBeInstanceOf(TextError);
      await none.k.stopAll();
    } finally { await k.stopAll(); }
  });

  it("ctx.fetch : hôte exact, « *.domaine » et « * » passent ; « ::1 » est de la boucle locale", async () => {
    const exact = await netPlugin(["api.contoso.invalid"]);
    const suffix = await netPlugin(["*.contoso.invalid"]);
    const star = await netPlugin(["*"]);
    const none = await netPlugin([]);
    try {
      await passed(exact.ctx, "https://api.contoso.invalid/");
      await expect(exact.ctx.fetch("https://other.contoso.invalid/")).rejects.toBeInstanceOf(TextError);
      await passed(suffix.ctx, "https://eu.api.contoso.invalid/");
      await expect(suffix.ctx.fetch("https://evilcontoso.invalid/")).rejects.toBeInstanceOf(TextError);
      await passed(star.ctx, "https://anything.invalid/");
      await passed(none.ctx, "http://[::1]:1/");
    } finally { for (const x of [exact, suffix, star, none]) await x.k.stopAll(); }
  });

});
