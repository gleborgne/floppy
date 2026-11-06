// Règles « à la demande » (Cordis) : plugins lazy, offres élément par élément (forks) et slots.
// Le scénario reprend le vrai cas : passer en Live doit libérer le LLM local sans qu'aucun plugin ne l'éteigne lui-même.
import { describe, it, expect } from "vitest";
import { Kernel, definePlugin, type PluginDef, type KernelConfigInput } from "../src/index.ts";

const quiet = () => {};

/** Fournisseur de modèles : un « processus » par élément, un seul à la fois (max 1). */
function models(j: string[], opts: { items?: () => string[]; failOn?: string } = {}): PluginDef<any> {
  return definePlugin({
    manifest: { id: "models", version: "0", licence: "MIT", provides: ["llm"] },
    apply(ctx) {
      ctx.offer("llm", {
        max: 1,
        items: () => (opts.items?.() ?? ["a", "b"]).map((id) => ({ id, label: id.toUpperCase(), slow: true })),
        start(f, item) {
          if (item === opts.failOn) throw new Error(`${item} ne démarre pas`);
          j.push(`spawn ${item}`);
          f.effect(() => { j.push(`kill ${item}`); });
          f.provide("llm", { baseURL: "x", model: item });
        },
      });
    },
  });
}

/** Cerveau lazy : tourne seulement si quelqu'un s'en sert ; son modèle vient du slot brain.main. */
function brain(j: string[]): PluginDef<any> {
  return definePlugin({
    manifest: {
      id: "brain", version: "0", licence: "MIT", provides: ["brain"], lazy: true,
      slots: [{ id: "brain.main", service: "llm", section: "cerveau", label: "Cerveau principal" }],
    },
    async apply(ctx) {
      const llm = await ctx.slot<{ model: string }>("brain.main");
      j.push(`brain ${llm?.model ?? "-"}`);
      ctx.effect(() => { j.push("brain stop"); });
      ctx.provide("brain", { name: llm?.model ?? "-", run: async function* () {}, reset() {} });
    },
  });
}

function live(j: string[]): PluginDef<any> {
  return definePlugin({
    manifest: { id: "live", version: "0", licence: "MIT", provides: ["live"] },
    apply(ctx) {
      ctx.offer("live", {
        items: () => [{ id: "gem", label: "Gemini Live", cloud: true }],
        start(f) { j.push("live open"); f.effect(() => { j.push("live close"); }); f.provide("live", { name: "gem", capabilities: { tools: "function" }, open: async () => { throw new Error(); } }); },
      });
    },
  });
}

/** Conversation : en Live elle ne demande pas le cerveau ; en Séparé elle le demande (ctx.use). */
function conv(j: string[]): PluginDef<any> {
  return definePlugin({
    manifest: {
      id: "conv", version: "0", licence: "MIT", optional: ["brain"],
      slots: [{ id: "conversation.live", service: "live", section: "cerveau", label: "Mode", none: "Séparé" }],
    },
    async apply(ctx) {
      const l = await ctx.slot("conversation.live");
      const b = l ? undefined : await ctx.use("brain");
      j.push(`conv ${l ? "live" : b ? `separe:${b.name}` : "sans cerveau"}`);
    },
  });
}

function setup(j: string[], extra: PluginDef<any>[] = [], slots: Record<string, string> = { "brain.main": "m/a" }) {
  const k = new Kernel({ logger: quiet, plugins: [models(j), brain(j), live(j), conv(j), ...extra] });
  const config: KernelConfigInput = {
    plugins: [{ id: "m", plugin: "models" }, { id: "brain", plugin: "brain" }, { id: "live", plugin: "live" }, { id: "conv", plugin: "conv" }],
    slots,
  };
  return { k, config };
}

const state = (k: Kernel, id: string) => k.status().find((s) => s.id === id)?.state;

describe("à la demande : plugins lazy, forks, slots", () => {
  it("Séparé : la conversation demande le cerveau, qui demande son modèle", async () => {
    const j: string[] = [];
    const { k, config } = setup(j);
    await k.applyConfig(config);
    expect(j).toEqual(["spawn a", "brain a", "conv separe:a"]);
    expect(state(k, "m/llm/a")).toBe("active");
    expect(k.status().find((s) => s.id === "m/llm/a")).toMatchObject({ fork: { parent: "m", service: "llm", item: "a" } });
  });

  it("passer en Live arrête le cerveau et le modèle local, sans code dans les plugins ; revenir les relance", async () => {
    const j: string[] = [];
    const { k, config } = setup(j);
    await k.applyConfig(config);
    j.length = 0;
    const r = await k.settings.change("slot.conversation.live", "live/gem", "ui");
    expect(r.ok).toBe(true);
    expect(j).toEqual(["live open", "conv live", "brain stop", "kill a"]);
    expect(state(k, "brain")).toBe("loaded");
    expect(state(k, "m/llm/a")).toBeUndefined();
    expect(k.slots().find((s) => s.id === "brain.main")).toMatchObject({ value: "m/a", state: "idle" });

    j.length = 0;
    await k.settings.change("slot.conversation.live", "@none", "ui");
    expect(j).toEqual(["spawn a", "brain a", "conv separe:a", "live close"]);
  });

  it("changer de modèle (max 1) : l'ancien est arrêté avant que le nouveau démarre", async () => {
    const j: string[] = [];
    const { k, config } = setup(j);
    await k.applyConfig(config);
    j.length = 0;
    expect((await k.settings.change("slot.brain.main", "m/b", "ui")).ok).toBe(true);
    expect(j).toEqual(["brain stop", "kill a", "spawn b", "brain b", "conv separe:b"]);
    expect(k.slots().find((s) => s.id === "brain.main")).toMatchObject({ value: "m/b", state: "active" });
  });

  it("un élément qui ne démarre pas : refus visible et retour à l'ancien choix", async () => {
    const j: string[] = [];
    const k = new Kernel({ logger: quiet, plugins: [models(j, { failOn: "b" }), brain(j), live(j), conv(j)] });
    await k.applyConfig({ plugins: [{ id: "m", plugin: "models" }, { id: "brain", plugin: "brain" }, { id: "live", plugin: "live" }, { id: "conv", plugin: "conv" }], slots: { "brain.main": "m/a" } });
    j.length = 0;
    const r = await k.settings.change("slot.brain.main", "m/b", "ui");
    expect(r.ok).toBe(false);
    expect(r.text).toContain("b ne démarre pas");
    expect(k.slots().find((s) => s.id === "brain.main")).toMatchObject({ value: "m/a", state: "active" });
    expect(j.at(-1)).toBe("conv separe:a");
  });

  it("deux slots sur le même élément : un seul fork", async () => {
    const j: string[] = [];
    const side = definePlugin({
      manifest: { id: "side", version: "0", licence: "MIT", slots: [{ id: "side.model", service: "llm", section: "cerveau", label: "Modèle annexe" }] },
      async apply(ctx) { const m = await ctx.slot<{ model: string }>("side.model"); j.push(`side ${m?.model}`); },
    });
    const { k, config } = setup(j, [side], { "brain.main": "m/a", "side.model": "m/a" });
    await k.applyConfig({ ...config, plugins: [...config.plugins!, { id: "side", plugin: "side" }] });
    expect(j.filter((x) => x.startsWith("spawn"))).toEqual(["spawn a"]);
    expect(j).toContain("side a");
    // La conversation passe en Live : le modèle reste, car « side » s'en sert encore.
    j.length = 0;
    await k.settings.change("slot.conversation.live", "live/gem", "ui");
    expect(j).not.toContain("kill a");
    expect(state(k, "m/llm/a")).toBe("active");
  });

  it("un plugin lazy démarre pour un inject et s'arrête quand son seul utilisateur part", async () => {
    const j: string[] = [];
    const bench = definePlugin({ manifest: { id: "bench", version: "0", licence: "MIT", inject: ["brain"] }, apply() { j.push("bench"); } });
    const k = new Kernel({ logger: quiet, plugins: [models(j), brain(j), bench] });
    const base = [{ id: "m", plugin: "models" }, { id: "brain", plugin: "brain" }];
    await k.applyConfig({ plugins: base, slots: { "brain.main": "m/a" } });
    expect(j).toEqual([]); // personne ne s'en sert : rien ne tourne
    await k.applyConfig({ plugins: [...base, { id: "bench", plugin: "bench" }], slots: { "brain.main": "m/a" } });
    expect(j).toEqual(["spawn a", "brain a", "bench"]);
    j.length = 0;
    await k.applyConfig({ plugins: base, slots: { "brain.main": "m/a" } });
    expect(j).toEqual(["brain stop", "kill a"]);
  });

  it("élément désactivé : le slot ne le donne plus, le consommateur redémarre sans lui", async () => {
    const j: string[] = [];
    let items = ["a", "b"];
    const k = new Kernel({ logger: quiet, plugins: [models(j, { items: () => items }), brain(j), live(j), conv(j)] });
    await k.applyConfig({ plugins: [{ id: "m", plugin: "models" }, { id: "brain", plugin: "brain" }, { id: "live", plugin: "live" }, { id: "conv", plugin: "conv" }], slots: { "brain.main": "m/a" } });
    j.length = 0;
    items = ["b"];
    await k.restart("conv"); // n'importe quelle opération relance le calcul
    expect(j).toContain("kill a");
    expect(j).toContain("brain -");
  });

  it("le réglage du slot liste les éléments offerts, avec « aucun » quand le slot est facultatif", async () => {
    const j: string[] = [];
    const { k, config } = setup(j);
    await k.applyConfig(config);
    const mode = k.settings.list().find((s) => s.key === "slot.conversation.live")!;
    expect(mode.options?.map((o) => o.value)).toEqual(["@none", "live/gem"]);
    expect(mode.role).toBe("conversation.live");
    const main = k.settings.list().find((s) => s.key === "slot.brain.main")!;
    expect(main.options?.map((o) => o.value)).toEqual(["m/a", "m/b"]);
    // Choisir un élément cloud à la voix demande l'accord : le refus laisse tout en place.
    k.approvals.setSettings({ read: "always", write: "ask", send: "ask", delete: "ask", physical: "ask", timeout_s: 1 });
    const pending = k.settings.change("slot.conversation.live", "Gemini Live", "voice");
    await new Promise((r) => setTimeout(r, 10));
    for (const a of k.approvals.pending()) k.approvals.respond(a.id, false, "test");
    expect((await pending).ok).toBe(false);
    expect(k.slots().find((s) => s.id === "conversation.live")?.value).toBe("@none");
  });
});
