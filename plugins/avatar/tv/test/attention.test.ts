import { describe, it, expect } from "vitest";
// @ts-expect-error Le dessin WebGL est un module JavaScript chargé par le corps.
import { Face } from "../renderer/face.js";

describe("attention de la TV", () => {
  it.each([false, true])("le réveil remplace les ZZZ par un visage attentif (mouvement réduit : %s)", (reducedMotion) => {
    const face = new Face(null, { reducedMotion });
    face.setState("sleep");
    face.setEmotion("sleepy", 1, 1500);
    expect(face.target(performance.now()).fx.has("zzz")).toBe(true);
    face.cue("wake");
    face.setState("listening");
    const { t, fx } = face.target(performance.now());
    expect(fx.has("zzz")).toBe(false);
    expect(t.eyeH).toBeGreaterThan(50);
    expect(t.mouth).toBeGreaterThan(0);
    expect(t.hR).toBeGreaterThan(1);
  });
  it("amorce chaque accent sans saut de cible et fond les changements de direction", () => {
    const face = new Face(null);
    face.t0 = 0; face.lastStep = 0; face.nextBlink = 1e9;
    face.setState("speaking");
    let previous = face.target(0).t.tilt;
    let largestChange = 0;
    for (let now = 10; now <= 1500; now += 10) {
      // Une seconde attaque arrive avant la fin du premier geste.
      face.setLevel(now % 430 < 200 ? 0.75 : 0);
      face.step(now);
      const target = face.target(now).t.tilt;
      largestChange = Math.max(largestChange, Math.abs(target - previous));
      previous = target;
    }
    expect(largestChange).toBeLessThan(0.5); // pas de nouvelle consigne de rotation brutale
  });

  it("relie les accents et la sortie de parole sans saut de position", () => {
    const face = new Face(null);
    face.t0 = 0; face.lastStep = 0; face.nextBlink = 1e9;
    face.setState("speaking");
    let previous = face.uniforms(0);
    let largestJump = 0;
    for (let now = 16; now <= 2400; now += 16) {
      face.setLevel(now % 640 < 256 ? 0.75 : 0);
      if (now === 2048) face.setState("listening");
      const frame = face.step(now);
      largestJump = Math.max(largestJump, Math.abs(frame.oy - previous.oy));
      previous = frame;
    }
    // Coordonnées du dessin : pas de téléportation de plusieurs pixels à l'attaque.
    expect(largestJump).toBeLessThan(1.5);
  });

  it("garde des mouvements un peu plus amples, sans grand balancement", () => {
    const face = new Face(null);
    face.t0 = 0; face.lastStep = 0; face.nextBlink = 1e9;
    face.setState("speaking");
    let tilt = 0, lift = 0;
    for (let now = 16; now <= 2000; now += 16) {
      face.setLevel(now % 640 < 256 ? 0.75 : 0);
      const frame = face.step(now);
      tilt = Math.max(tilt, Math.abs(frame.tilt) * 180 / Math.PI);
      lift = Math.max(lift, -frame.oy);
    }
    // Sur cette séquence : auparavant 2,59° et 5,63 px. Plus visible, mais toujours discret.
    expect(tilt).toBeGreaterThan(2.9); expect(tilt).toBeLessThan(3.4);
    expect(lift).toBeGreaterThan(5.9); expect(lift).toBeLessThan(6.8);
  });

  it("le mouvement réduit désactive aussi le soulèvement et le zoom de parole", () => {
    const face = new Face(null, { reducedMotion: true });
    face.t0 = 0; face.lastStep = 0;
    face.setState("speaking"); face.setLevel(0.9);
    for (let now = 16; now <= 640; now += 16) {
      const frame = face.step(now);
      expect(frame.oy).toBe(0); expect(frame.breath).toBe(1); expect(frame.tilt).toBe(0);
    }
  });

  it("préserve la respiration au passage parole, écoute et veille", () => {
    const face = new Face(null);
    face.t0 = 0; face.lastStep = 0; face.nextBlink = 1e9;
    face.setState("speaking");
    for (let now = 16; now <= 720; now += 16) face.step(now);
    const before = face.uniforms(720);
    for (const state of ["listening", "sleep", "idle"]) {
      face.setState(state);
      const after = face.uniforms(720);
      expect(after.oy).toBe(before.oy);
      expect(after.breath).toBe(before.breath);
    }
  });

  it("ferme la bouche dans les pauses même avec une émotion à bouche ouverte", () => {
    const face = new Face(null);
    face.setState("speaking"); face.setEmotion("laugh"); face.levelSmooth = 0;
    expect(face.target(performance.now()).t.mouthOpen).toBe(0);
  });
  it("souligne les attaques vocales avec les yeux et la posture", () => {
    const face = new Face(null);
    face.setState("speaking");
    const now = performance.now();
    const rest = face.target(now).t;
    face.setLevel(0.75); face.step(now + 33);
    expect(face.speechAccent).toBe(0); // le geste démarre doucement
    for (let ms = 66; ms <= 165; ms += 33) face.step(now + ms);
    const accent = face.target(now + 165).t;
    expect(accent.eyeH).toBeGreaterThan(rest.eyeH + 2);
    expect(Math.abs(accent.tilt - rest.tilt)).toBeGreaterThan(1);
    for (let ms = 198; ms <= 1100; ms += 33) face.step(now + ms);
    expect(face.speechAccent).toBeLessThan(0.01); // un volume constant ne répète pas les gestes
    face.setLevel(0); face.step(now + 1133);
    face.setLevel(0.6); face.step(now + 1166);
    for (let ms = 1199; ms <= 1298; ms += 33) face.step(now + ms);
    expect(face.speechAccent).toBeGreaterThan(0.5);
    face.setState("listening"); expect(face.speechAccent).toBe(0);
  });
  it("garde le regard malicieux et n'ajoute pas d'accents en mouvement réduit", () => {
    const face = new Face(null, { reducedMotion: true });
    face.setState("speaking"); face.setEmotion("mischief");
    face.setLevel(0.8); face.step(performance.now() + 33);
    expect(face.speechAccent).toBe(0);
    expect(face.target(performance.now()).t.lookX).toBe(8);
  });
  it("écoute malgré la souris puis détourne le regard pour réfléchir", () => {
    const face = new Face(null);
    face.lookAt(1, 1); face.setState("listening");
    expect(face.target(performance.now()).t).toMatchObject({ lookX: 0, lookY: 0 });
    face.setState("thinking");
    expect(face.target(performance.now()).t).toMatchObject({ lookX: 10, lookY: -8 });
    face.setState("speaking");
    expect(Math.abs(face.target(performance.now()).t.lookX)).toBeLessThan(5);
  });
  it("regarde l'accord puis revient à l'écoute sans geste résiduel", () => {
    const face = new Face(null);
    face.setAttention("approval");
    expect(face.target(performance.now()).t.lookY).toBe(-12);
    face.setState("speaking"); face.cue("startle"); face.cue("nod"); face.setState("listening");
    expect(face.moves).toEqual([]); expect(face.flash).toBeNull();
    expect(face.target(performance.now()).t.lookY).toBe(0);
  });
  it("respecte le mouvement réduit", () => {
    const face = new Face(null, { reducedMotion: true });
    face.setState("thinking"); face.cue("perk");
    expect(Object.values(face.vel).every(v => v === 0)).toBe(true);
    expect(face.target(performance.now()).t.lookY).toBe(-8);
  });
  it("préserve le geste de réveil qui précède l'écoute", () => {
    const face = new Face(null);
    face.setState("sleep"); face.cue("wake"); face.setState("listening");
    expect(face.moves).toHaveLength(1);
  });
});
