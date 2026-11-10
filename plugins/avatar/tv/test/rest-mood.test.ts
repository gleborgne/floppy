import { describe, it, expect } from "vitest";
// @ts-expect-error Le dessin WebGL est un module JavaScript chargé par le corps.
import { Face } from "../renderer/face.js";

/** Cible du visage (avant ressort) pour un état, une humeur et une émotion donnés. */
function target(opts: { state?: string; valence?: number; energy?: number; emotion?: string; intensity?: number }) {
  const face = new Face(null);
  face.t0 = 0;
  face.state = opts.state ?? "idle";
  face.levelSmooth = 0.6;
  if (opts.emotion) face.setEmotion(opts.emotion, 0, opts.intensity ?? 1);
  face.setMood(opts.valence ?? 0.2, opts.energy ?? 0.6);
  face.saccade = { x: 0, y: 0, until: Infinity };
  return face.target(1000).t;
}

describe("visage de la TV au repos selon l'humeur", () => {
  it("humeur de base : petit sourire, yeux sans inclinaison", () => {
    const t = target({});
    expect(t.mouth).toBeGreaterThan(0);
    expect(t.mouth).toBeLessThan(0.7);
    expect(t.mouthW).toBeGreaterThan(0);
    expect(t.lidAngle).toBe(0);
  });
  it("le vrai « happy » reste nettement plus grand que le sourire de repos", () => {
    expect(target({ emotion: "happy" }).mouth).toBeGreaterThan(target({}).mouth * 2);
    expect(target({ valence: 0.6, energy: 0.7 }).mouth).toBeGreaterThan(target({}).mouth);
  });
  it("seul longtemps : paupières lourdes, mais ni inclinaison ni bouche tombante", () => {
    for (const energy of [0.3, 0.1, 0]) {
      const heavier = energy <= 0.1 ? 0.2 : 0;
      const t = target({ energy });
      expect(t.lidTop).toBeGreaterThan(heavier);
      expect(t.lidAngle).toBeGreaterThanOrEqual(0);
      expect(t.mouth).toBeGreaterThanOrEqual(0);
    }
    expect(target({ energy: 0.05 }).lidTop).toBeGreaterThan(target({ energy: 0.3 }).lidTop);
  });
  it("humeur légèrement négative : pas penaud ; franchement négative : penaud, et proportionnel", () => {
    const light = target({ valence: -0.15 });
    expect(light.lidAngle).toBe(0);
    expect(light.mouth).toBeGreaterThanOrEqual(0);
    expect(target({ valence: -0.3 }).lidAngle).toBe(0);
    const bad = target({ valence: -0.6, energy: 0.5 });
    expect(bad.lidAngle).toBeLessThan(0);
    expect(bad.mouth).toBeLessThan(0);
    expect(target({ valence: -1, energy: 0.5 }).lidAngle).toBeLessThan(bad.lidAngle);
  });
  it("une émotion explicite (tired, sorry) se rend comme avant, quelle que soit l'humeur", () => {
    for (const [name, preset] of [["tired", { lidTop: 0.5, lidAngle: -8, eyeY: -4, mouth: -0.1, mouthW: 22 }],
      ["sorry", { lidTop: 0.26, lidAngle: -16, eyeY: -10, mouth: -0.3, mouthW: 27 }]] as const) {
      for (const [valence, energy] of [[0.2, 0.6], [0.8, 0.1], [-0.6, 0.9]]) {
        const t = target({ emotion: name, valence, energy });
        expect(t.lidTop).toBeCloseTo(preset.lidTop, 9);
        expect(t.lidAngle).toBeCloseTo(preset.lidAngle, 9);
        expect(t.mouth).toBeCloseTo(preset.mouth, 9);
        expect(t.mouthW).toBeCloseTo(preset.mouthW, 9);
      }
    }
  });
  it("écoute, réflexion, parole : cibles inchangées à l'humeur de base (valeurs d'avant)", () => {
    const l = target({ state: "listening" });
    expect([l.mouth, l.mouthW, l.lidTop, l.lidAngle, l.lidBot, l.eyeY, l.eyeH]).toEqual([0.35, 28, 0, 0, 0, -10, 56]);
    expect(l.halo).toBeCloseTo(1.122765, 6);
    const th = target({ state: "thinking" });
    expect([th.mouth, th.mouthW, th.lidTop, th.lidAngle, th.lidBot, th.eyeY, th.eyeH]).toEqual([0, 19, 0, 0, 0.12, -10, 56]);
    expect(th.halo).toBeCloseTo(0.8925, 6);
    const s = target({ state: "speaking" });
    expect([s.mouth, s.lidTop, s.lidAngle, s.lidBot, s.eyeY, s.eyeH]).toEqual([0, 0, 0, 0, -10, 56]);
    expect(s.mouthW).toBeCloseTo(34.97429138154031, 6);
  });
  it("en conversation, la fatigue ne change pas le visage et la veille reste la veille", () => {
    expect(target({ state: "listening", energy: 0.05 }).lidTop).toBe(0);
    expect(target({ state: "sleep", valence: 0.2, energy: 0.05 }).eyeH).toBe(5);
  });
});
