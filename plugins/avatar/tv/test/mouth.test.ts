import { describe, it, expect } from "vitest";
// @ts-expect-error Le dessin WebGL est un module JavaScript chargé par le corps.
import { Face } from "../renderer/face.js";
// @ts-expect-error idem
import { create } from "../renderer/index.js";

/** Largeur cible de la bouche (avant ressort) pour un état et une forme donnés. */
function width(opts: { state: string; emotion?: string; wide?: number | null; reducedMotion?: boolean; level?: number }) {
  const face = new Face(null, { reducedMotion: opts.reducedMotion });
  face.t0 = 0; // ondulation de syllabe identique d'un visage à l'autre
  face.state = opts.state;
  if (opts.emotion) face.setEmotion(opts.emotion, 0, 1);
  face.levelSmooth = opts.level ?? 0.6;
  if (opts.wide !== null && opts.wide !== undefined) face.setMouth(0.5, opts.wide);
  return face.target(1000).t;
}

describe("forme de la bouche de la TV", () => {
  it("en parlant, la largeur suit wide : arrondie plus étroite, étirée plus large", () => {
    const round = width({ state: "speaking", wide: 0 }).mouthW;
    const mid = width({ state: "speaking", wide: 0.5 }).mouthW;
    const wide = width({ state: "speaking", wide: 1 }).mouthW;
    expect(round).toBeLessThan(mid);
    expect(mid).toBeLessThan(wide);
  });
  it("l'émotion reste lisible : une bouche triste reste triste, même étirée", () => {
    const t = width({ state: "speaking", emotion: "sad", wide: 1 });
    expect(t.mouth).toBeLessThan(0);
  });
  it("pas de jeu de largeur dans une pause de la voix ni au repos", () => {
    expect(width({ state: "speaking", wide: 1, level: 0 }).mouthW).toBe(width({ state: "speaking", wide: 0, level: 0 }).mouthW);
    expect(width({ state: "idle", wide: 1 }).mouthW).toBe(width({ state: "idle", wide: 0 }).mouthW);
    expect(width({ state: "listening", wide: 1 }).mouthW).toBe(width({ state: "listening", wide: 0 }).mouthW);
  });
  it("mouvement réduit : l'ouverture seule, aucune largeur", () => {
    expect(width({ state: "speaking", wide: 1, reducedMotion: true })).toEqual(width({ state: "speaking", wide: 0, reducedMotion: true }));
  });
  it("l'avatar expose setMouth, et en mouvement réduit il ne le transmet pas au visage", () => {
    const canvas = { style: {}, getContext: () => null };
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, requestAnimationFrame: g.requestAnimationFrame };
    g.document = { createElement: () => canvas };
    g.requestAnimationFrame = () => 0;
    try {
      const avatar = create({ append() {} }, { reducedMotion: true });
      expect(typeof avatar.setMouth).toBe("function");
      expect(() => avatar.setMouth(0.5, 1)).not.toThrow();
    } finally { g.document = saved.document; g.requestAnimationFrame = saved.requestAnimationFrame; }
  });
  it("sans setMouth, la cible est celle d'avant (ouverture + largeur de voix + ondulation)", () => {
    const f = new Face(null);
    f.state = "speaking"; f.levelSmooth = 0.6;
    const t = f.target(1000).t;
    const time = (1000 - f.t0) / 1000;
    expect(t.mouthW).toBeCloseTo(28 + 0.6 * (8 + Math.sin(time * 13.7) * 4), 6);
    expect(t.mouth).toBe(0);
  });
  it("la forme passe par les ressorts : aucun saut de largeur d'une image à l'autre", () => {
    const f = new Face(null);
    f.t0 = 0; f.lastStep = 0; f.nextBlink = 1e9;
    f.state = "speaking"; f.levelSmooth = 0.6; f.setLevel(0.6); f.setMouth(0.5, 0);
    for (let now = 16; now <= 600; now += 16) f.step(now);
    const before = f.cur.mouthW;
    f.setMouth(0.5, 1);
    f.step(616);
    expect(Math.abs(f.cur.mouthW - before)).toBeLessThan(3);
  });
});
