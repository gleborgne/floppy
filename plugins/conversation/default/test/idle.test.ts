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
