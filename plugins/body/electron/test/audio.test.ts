import { describe, it, expect } from "vitest";
import { toFloat32 } from "../src/index.ts";

describe("toFloat32 (audio du micro reçu par le MessagePort)", () => {
  const src = new Float32Array([0.5, -0.25, 1]);
  it("garde un Float32Array", () => expect(toFloat32(src)).toBe(src));
  it("relit un ArrayBuffer", () => expect([...toFloat32(src.buffer.slice(0))]).toEqual([0.5, -0.25, 1]));
  it("relit des OCTETS comme des float32 (jamais élément par élément)", () => {
    const bytes = new Uint8Array(src.buffer.slice(0));
    expect([...toFloat32(bytes)]).toEqual([0.5, -0.25, 1]);
    expect([...toFloat32(Buffer.from(bytes))]).toEqual([0.5, -0.25, 1]);
  });
});
