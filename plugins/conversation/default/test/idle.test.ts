// Silence du cerveau : au-delà du délai, le tour échoue et le cerveau est prévenu ; un cerveau qui parle n'est jamais coupé.
import { describe, it, expect } from "vitest";
import { withIdleTimeout } from "../src/idle.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("silence du cerveau", () => {
  it("un cerveau qui se tait fait échouer le tour et reçoit l'arrêt", async () => {
    const stall = new AbortController();
    async function* brain() { yield "a"; await new Promise(() => {}); }
    const got: string[] = [];
    await expect((async () => { for await (const e of withIdleTimeout(brain(), 30, stall)) got.push(e); })()).rejects.toThrow(/ne répond plus/);
    expect(got).toEqual(["a"]);
    expect(stall.signal.aborted).toBe(true);
  });

  it("le délai compte le silence entre deux événements, pas la durée du tour", async () => {
    const stall = new AbortController();
    async function* brain() { for (let i = 0; i < 5; i++) { await wait(15); yield i; } }
    const got: number[] = [];
    for await (const e of withIdleTimeout(brain(), 40, stall)) got.push(e);
    expect(got).toEqual([0, 1, 2, 3, 4]);
    expect(stall.signal.aborted).toBe(false);
  });
});

describe("fermeture du cerveau", () => {
  it("un tour arrêté (break) ou une erreur ferme le générateur du cerveau", async () => {
    for (const how of ["break", "throw"] as const) {
      let closed = false;
      async function* brain() { try { yield 1; yield 2; await new Promise(() => {}); } finally { closed = true; } }
      try {
        for await (const e of withIdleTimeout(brain(), 1000, new AbortController())) {
          if (e === 2) { if (how === "break") break; throw new Error("dans le tour"); }
        }
      } catch { /* l'erreur du tour */ }
      await new Promise((r) => setTimeout(r, 5));
      expect(closed, how).toBe(true);
    }
  });
});
