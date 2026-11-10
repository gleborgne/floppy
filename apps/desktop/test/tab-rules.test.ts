import { describe, it, expect } from "vitest";
import { isLight } from "../src/renderer/tab-rules.ts";

describe("isLight", () => {
  it("un ou deux réglages restent sur la page (ex. le Ton sous Voix)", () => {
    expect(isLight([{ key: "tone" }])).toBe(true);
    expect(isLight([{ key: "a" }, { key: "b" }])).toBe(true);
  });
  it("trois réglages ou plus ont leur onglet", () => {
    expect(isLight([{ key: "a" }, { key: "b" }, { key: "c" }])).toBe(false);
  });
});
