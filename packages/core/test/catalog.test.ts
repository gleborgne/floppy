import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, ItemStore, tr, type ItemInfo } from "../src/index.ts";

function plugin() {
  const items: Record<string, ItemInfo> = {
    a: { id: "a", label: { fr: "Modèle A", en: "Model A" }, enabled: true, aliases: ["alpha"] },
    c: { id: "c", label: "Nuage", enabled: false, cloud: true },
  };
  return definePlugin({
    manifest: { id: "fake-items", version: "0.0.1", licence: "MIT" },
    apply(ctx) {
      ctx.items.declare({
        id: "fake", section: "cerveau", label: "Faux",
        kinds: [{ id: "k", label: "Type", fields: [{ key: "name", label: "Nom", type: "text", required: true }] }],
        list: () => Object.values(items),
        add: async (_k, v) => { const id = String(v.name); items[id] = { id, label: id, enabled: true }; return { ok: true, text: "ok", id }; },
        setEnabled: async (id, on) => { items[id]!.enabled = on; return { ok: true, text: "" }; },
      });
    },
  });
}

describe("catalogue des éléments", () => {
  it("liste, ajoute, active ; refuse l'ajout à la voix ; accord pour activer un élément cloud à la voix", async () => {
    const k = new Kernel({ plugins: [plugin()] });
    await k.applyConfig({ plugins: [{ id: "f", plugin: "fake-items" }] });
    const snap = await k.items.snapshot();
    expect(snap[0]!.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(snap[0]!.can.add).toBe(true);

    expect((await k.items.run({ op: "add", provider: "fake", kind: "k", values: {} }, "ui")).text).toMatch(/Nom/);
    expect((await k.items.run({ op: "add", provider: "fake", kind: "k", values: { name: "b" } }, "voice")).ok).toBe(false);
    expect((await k.items.run({ op: "add", provider: "fake", kind: "k", values: { name: "b" } }, "ui")).id).toBe("b");

    // Activer un élément cloud à la voix : accord demandé (ici refusé).
    k.bus.on("approval.request", (r) => { k.approvals.respond(r.id, false, "test"); });
    const r = await k.items.run({ op: "enable", provider: "fake", id: "c", on: true }, "voice");
    expect(r.ok).toBe(false);
    expect((await k.items.run({ op: "enable", provider: "fake", id: "a", on: false }, "voice")).ok).toBe(true);

    // Outil vocal : trouve par alias, dans n'importe quelle langue.
    const t = await k.tools.call("activer_element", { nom: "alpha", actif: true });
    expect(t.status).toBe("done");
    expect((await k.items.find("Model A")).length).toBe(1);
    await k.stopAll();
    expect((await k.items.snapshot()).length).toBe(0);
  });

  it("ItemStore : ajouts, modifications, désactivation, suppression", () => {
    const s = ItemStore.in(mkdtempSync(join(tmpdir(), "items-")), "x");
    const id = s.add("k", { label: "Mon Modèle" }, "Mon Modèle", ["mon-modele"]);
    expect(id).toBe("mon-modele-2");
    s.update("base", { label: "B2" });
    s.setEnabled("base", false);
    expect(s.merge({ base: { label: "B" } })).toMatchObject({ base: { label: "B2" }, [id]: { label: "Mon Modèle", _added: true } });
    expect(s.isEnabled("base")).toBe(false);
    s.remove("base");
    expect(Object.keys(s.merge({ base: { label: "B" } }))).toEqual([id]);
    const again = new ItemStore(s.file);
    expect(again.data.added[id]).toBeTruthy();
  });

  it("textes en plusieurs langues", () => {
    expect(tr({ fr: "Voix", en: "Voice" }, "en")).toBe("Voice");
    expect(tr({ fr: "Voix" }, "en")).toBe("Voix");
    expect(tr("Voix", "en")).toBe("Voix");
  });
});

describe("catalogue des applications", () => {
  it("chaque fiche dit les services du plugin : le catalogue ouvert depuis un rôle filtre avec", async () => {
    const addable = (id: string, provides?: string[]) => definePlugin({
      manifest: { id, version: "0.0.1", licence: "MIT", ...(provides ? { provides } : {}), addable: { section: "ecoute", label: id } },
      apply() {},
    });
    const k = new Kernel({ logger: () => {}, plugins: [addable("wakeword-x", ["wakeword"]), addable("stt-x", ["vad", "stt"]), addable("rien")], home: mkdtempSync(join(tmpdir(), "apps-")) });
    await k.applyConfig({ plugins: [] });
    const kinds = k.items.provider("apps-ecoute")!.kinds!;
    expect(kinds.find((x) => x.id === "wakeword-x")?.provides).toEqual(["wakeword"]);
    expect(kinds.find((x) => x.id === "stt-x")?.provides).toEqual(["vad", "stt"]);
    expect(kinds.find((x) => x.id === "rien")?.provides).toBeUndefined();
  });
});
