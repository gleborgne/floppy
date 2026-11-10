import { describe, it, expect } from "vitest";
import { MouthShape } from "../src/renderer/mouth-shape.ts";

const RATE = 48000, BINS = 256;
const binOf = (hz: number): number => Math.round(hz / (RATE / 2 / BINS));
/** Spectre en dB : un pic à une fréquence au-dessus d'un plancher. */
function tone(hz: number, db = -30, floor = -100): Float32Array {
  const b = new Float32Array(BINS).fill(floor);
  b[binOf(hz)] = db;
  return b;
}
const noise = (db = -60): Float32Array => new Float32Array(BINS).fill(db);
const silence = (): Float32Array => new Float32Array(BINS).fill(-Infinity);
/** Fait tourner le module au rythme de 33 ms. */
function run(m: MouthShape, spectrum: Float32Array, level: number, frames: number) {
  let r = { open: 0, wide: 0 };
  for (let i = 0; i < frames; i++) r = m.update(spectrum, RATE, level, 33);
  return r;
}

describe("forme de la bouche d'après le son", () => {
  it("un son grave donne une bouche arrondie, un son aigu ou bruité une bouche étirée", () => {
    expect(run(new MouthShape(), tone(400), 0.6, 10).wide).toBeLessThan(0.1);
    expect(run(new MouthShape(), tone(4000), 0.6, 10).wide).toBeGreaterThan(0.9);
    expect(run(new MouthShape(), noise(), 0.6, 10).wide).toBeGreaterThan(0.9);
  });
  it("une voyelle fermée (second formant aigu, premier formant fort) est entre les deux", () => {
    const b = tone(300, -30); b[binOf(2300)] = -38;
    const w = run(new MouthShape(), b, 0.6, 10).wide;
    expect(w).toBeGreaterThan(0.1); expect(w).toBeLessThan(0.9);
  });
  it("le silence ramène l'ouverture et la forme à zéro, en douceur", () => {
    const m = new MouthShape();
    run(m, noise(), 0.8, 10);
    const first = m.update(silence(), RATE, 0, 33);
    expect(first.wide).toBeGreaterThan(0); expect(first.open).toBeGreaterThan(0); // pas de saut
    expect(run(m, silence(), 0, 20)).toEqual({ open: 0, wide: 0 });
  });
  it("l'ouverture suit le niveau actuel sans le gonfler ni le réduire en moyenne", () => {
    expect(run(new MouthShape(), tone(400), 0.5, 30).open).toBeCloseTo(0.5, 2);
  });
  it("le lissage ne traîne pas (quelques dizaines de ms) et ne dépend pas de la cadence", () => {
    const a = new MouthShape(), b = new MouthShape();
    a.update(tone(4000), RATE, 0.6, 33); a.update(tone(4000), RATE, 0.6, 33);
    for (let i = 0; i < 4; i++) b.update(tone(4000), RATE, 0.6, 16.5);
    expect(a.wide).toBeGreaterThan(0.8);             // 66 ms : presque arrivé
    expect(Math.abs(a.wide - b.wide)).toBeLessThan(0.001);
  });
  it("reset remet tout à zéro", () => {
    const m = new MouthShape(); run(m, noise(), 0.8, 5); m.reset();
    expect([m.open, m.wide]).toEqual([0, 0]);
  });
});
