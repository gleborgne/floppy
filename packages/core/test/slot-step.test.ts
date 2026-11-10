// Place d'un slot dans la chaîne de sa rubrique (`step`) : déclarée dans le manifeste, rendue à la fenêtre.
import { describe, it, expect } from "vitest";
import { Kernel, definePlugin } from "../src/index.ts";

const chain = (step?: number) => definePlugin({
  manifest: {
    id: "chain", version: "0", licence: "MIT",
    slots: [
      { id: "a.first", service: "vad", section: "listening", label: "Parole", ...(step === undefined ? {} : { step }) },
      { id: "a.plain", service: "stt", section: "listening", label: "Texte" },
    ],
  },
  apply() {},
});

describe("slots en chaîne (step)", () => {
  it("la place déclarée arrive dans l'état des slots ; sans place, rien", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [chain(2)] });
    await k.applyConfig({ plugins: [{ id: "chain", plugin: "chain" }] });
    expect(k.slots().find((s) => s.id === "a.first")?.step).toBe(2);
    expect(k.slots().find((s) => s.id === "a.plain")).not.toHaveProperty("step");
  });

  it("une place qui n'est pas un entier positif est refusée", async () => {
    const k = new Kernel({ logger: () => {}, plugins: [chain(0)] });
    await k.applyConfig({ plugins: [{ id: "chain", plugin: "chain" }] });
    expect(k.status().find((s) => s.id === "chain")?.state).toBe("error");
  });
});
