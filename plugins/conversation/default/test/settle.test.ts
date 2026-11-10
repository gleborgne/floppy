import { describe, it, expect } from "vitest";
import { EmotionSettler, SETTLE_FACTOR, SETTLE_FLOOR } from "../src/settle.ts";

describe("émotion qui s'apaise", () => {
  it("1 → 0.6 → 0.36 → plus d'émotion, puis rien jusqu'à une nouvelle étiquette", () => {
    const s = new EmotionSettler();
    const seen = [s.next({ emotion: "joy", intensity: 1 }), s.next(), s.next(), s.next(), s.next()];
    expect(seen.map((x) => x.emotion)).toEqual(["joy", "joy", "joy", undefined, undefined]);
    expect(seen.map((x) => x.intensity)).toEqual([1, 0.6, 0.6 * 0.6, undefined, undefined]);
    expect(seen.map((x) => x.cue?.emotion)).toEqual(["joy", "joy", "joy", "neutral", undefined]);
    expect(seen.map((x) => x.settling)).toEqual([false, true, true, true, false]);
  });
  it("sans intensité (= 1) : la suivante vaut 0.6 ; la phrase à étiquette garde `undefined`", () => {
    const s = new EmotionSettler();
    expect(s.next({ emotion: "happy" })).toEqual({ emotion: "happy", cue: { emotion: "happy" }, settling: false });
    expect(s.next().intensity).toBeCloseTo(SETTLE_FACTOR);
  });
  it("une émotion forte dure plus : 1.25 → 0.75 → 0.45 → 0.27 (tombée)", () => {
    const s = new EmotionSettler();
    s.next({ emotion: "excited", intensity: 1.25 });
    expect(s.next().intensity).toBeCloseTo(0.75);
    expect(s.next().intensity).toBeCloseTo(0.45);
    expect(s.next().emotion).toBeUndefined();
  });
  it("une nouvelle étiquette repart à pleine force, même après la chute", () => {
    const s = new EmotionSettler();
    s.next({ emotion: "joy" }); s.next(); s.next(); s.next();
    expect(s.next({ emotion: "sorry", intensity: 0.8 })).toMatchObject({ emotion: "sorry", intensity: 0.8, settling: false });
    expect(s.next().intensity).toBeCloseTo(0.48);
  });
  it("sans étiquette depuis le début : rien", () => {
    expect(new EmotionSettler().next()).toEqual({ settling: false });
  });
  it("le seuil est bien en dessous de la 2e étape", () => {
    expect(SETTLE_FACTOR ** 2).toBeGreaterThan(SETTLE_FLOOR);
    expect(SETTLE_FACTOR ** 3).toBeLessThan(SETTLE_FLOOR);
  });
});
