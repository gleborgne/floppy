import { describe, it, expect } from "vitest";
// @ts-expect-error module .js sans types
import { isLight } from "../src/renderer/tab-rules.js";

describe("isLight", () => {
  it("un ou deux réglages restent sur la page (ex. le Ton sous Voix)", () => {
    expect(isLight([{ key: "ton" }])).toBe(true);
    expect(isLight([{ key: "a" }, { key: "b" }])).toBe(true);
  });
  it("trois réglages ou plus ont leur onglet", () => {
    expect(isLight([{ key: "a" }, { key: "b" }, { key: "c" }])).toBe(false);
  });
});
