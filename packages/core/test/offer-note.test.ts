// La note d'un élément offert (OfferItem.note) arrive dans les options du slot, donc dans la fenêtre des réglages.
import { it, expect } from "vitest";
import { Kernel, T, definePlugin } from "../src/index.ts";

it("la note d'un élément offert est dans les options du slot, relue à chaque lecture", async () => {
  let plays = true;
  const provider = definePlugin({
    manifest: { id: "p", version: "0", licence: "MIT", provides: ["llm"] },
    apply(ctx) {
      ctx.offer("llm", {
        items: () => [{ id: "a", label: "A", note: plays ? T("Oui", "Yes") : T("Non", "No") }, { id: "b", label: "B" }],
        start(f) { f.provide("llm", { baseURL: "x", model: "a" }); },
      });
    },
  });
  const user = definePlugin({
    manifest: { id: "u", version: "0", licence: "MIT", slots: [{ id: "voice.tts", service: "llm", section: "voix", label: "Voix" }] },
    async apply(ctx) { await ctx.slot("voice.tts"); },
  });
  const k = new Kernel({ logger: () => {}, plugins: [provider, user] });
  try {
    await k.applyConfig({ plugins: [{ id: "p", plugin: "p" }, { id: "u", plugin: "u" }] });
    const options = () => (k.settings.list().find((s) => s.key === "slot.voice.tts")!.options ?? []) as { value: string; note?: unknown }[];
    expect(options().find((o) => o.value === "p/a")!.note).toEqual({ fr: "Oui", en: "Yes" });
    expect(options().find((o) => o.value === "p/b")).not.toHaveProperty("note");
    plays = false;
    expect(options().find((o) => o.value === "p/a")!.note).toEqual({ fr: "Non", en: "No" });
  } finally { await k.stopAll(); }
});
