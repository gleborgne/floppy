// Les voix du système ne jouent pas les émotions : leur ligne dans les réglages le dit.
import { it, expect, vi } from "vitest";
import tts from "../src/index.ts";

vi.mock("../src/engines.ts", async (original) => ({
  ...await original<typeof import("../src/engines.ts")>(),
  engineFor: () => ({ label: "test", missing: "", voices: async () => [{ id: "julie", name: "Julie", lang: "fr-FR" }], open: () => ({}) }),
}));

it("chaque voix du système porte la note « ne joue pas les émotions »", async () => {
  let items: { id: string; note?: unknown }[] = [];
  const ctx = {
    assistant: { language: "fr" }, items: { status() {} }, log() {},
    offer(_name: string, def: { items(): typeof items }) { items = def.items(); },
  };
  await tts.apply(ctx as never, { languages: ["fr"] } as never);
  expect(items).toHaveLength(1);
  expect(items[0]!.note).toEqual({ fr: "Ne joue pas les émotions", en: "Does not play emotions" });
});
