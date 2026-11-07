import { it, expect } from "vitest";
import { AvatarMotion } from "../../../../apps/desktop/src/renderer/avatar-motion.ts";
// @ts-expect-error Le dessin de l'avatar est chargé directement en JavaScript.
import { SpeechGestures } from "../renderer/speech-gestures.js";
// @ts-expect-error Le dessin de l'avatar est chargé directement en JavaScript.
import { Face } from "../renderer/face.js";

it("la TV interprète aussi les signaux communs sans les cumuler avec sa séquence autonome", () => {
  const motion = new AvatarMotion(); motion.setState("speaking"); motion.play("question", 1, 10); motion.setTime(10.4);
  const shared = new Face(null, { motion }), standalone = new Face(null);
  shared.setState("speaking"); standalone.setState("speaking");
  standalone.setSpeechGesture("question", 1, 10); standalone.setSpeechTime(10.4);
  for (const key of ["tilt", "lookX", "lookY", "hR"]) expect(shared.target(1000).t[key]).toBeCloseTo(standalone.target(1000).t[key]);
  shared.setSpeechGesture("playful", 1, 10); shared.setSpeechTime(10.4);
  expect(shared.target(1000).t.lookY).toBeCloseTo(standalone.target(1000).t.lookY);
});

it("donne trois gestes distincts qui reviennent seuls au repos", () => {
  for (const intent of ["explain", "playful", "question"]) {
    const g = new SpeechGestures(); g.play(intent, 1, 0);
    expect(Object.values(g.sample(0)).every(v => v === 0)).toBe(true);
    const pose = g.sample(460);
    if (intent === "explain") { expect(pose.speechLift).toBeLessThan(0); expect(pose.eyeY).toBeGreaterThan(0); }
    if (intent === "playful") { expect(pose.mouth).toBeGreaterThan(0); expect(pose.lidBot).toBeGreaterThan(0); }
    if (intent === "question") { expect(pose.lookY).toBeLessThan(0); expect(pose.hR).toBeGreaterThan(0); }
    expect(Object.values(g.sample(1800)).every(v => v === 0)).toBe(true);
  }
});

it("fond une nouvelle intention sans saut et varie les répétitions", () => {
  const g = new SpeechGestures(); g.play("playful", 1, 0);
  const before = g.sample(460);
  g.play("question", 1, 460);
  expect(g.sample(460)).toEqual(before);
  g.play("none", 1, 800);
  expect(Object.values(g.sample(1100)).every(v => v === 0)).toBe(true);
  const a = new SpeechGestures(); a.play("playful", 1, 0);
  const first = a.sample(460).tilt;
  a.play("playful", 1, 2000);
  expect(first * a.sample(2460).tilt).toBeLessThan(0);
});

it("réduit le geste avec le profil discret et évite les redémarrages trop rapprochés", () => {
  const full = new SpeechGestures(), quiet = new SpeechGestures();
  full.play("question", 1, 0); quiet.play("question", 0.45, 0);
  expect(quiet.sample(400).tilt).toBeCloseTo(full.sample(400).tilt * 0.45);
  const before = full.sample(400);
  full.play("question", 1, 400);
  expect(full.sample(400)).toEqual(before);
});

it("la TV suit l'horloge audio, garde la bouche liée au son et annule le geste interrompu", () => {
  const f = new Face(null); f.setState("speaking"); f.setSpeechTime(10);
  f.setSpeechGesture("question", 1, 10);
  f.setSpeechTime(10.4);
  const pose = f.target(1000).t;
  expect(pose.lookY).toBeLessThan(0); expect(pose.mouthOpen).toBe(0);
  expect(f.target(5000).t).toEqual(pose); // le temps mural ne fait pas avancer le geste pendant duck
  f.setSpeechGesture(null); f.setSpeechTime(11);
  expect(f.target(5100).t.lookY).toBe(0);
  f.setSpeechGesture("playful", 1, 11); f.setState("listening"); f.setState("speaking");
  f.setSpeechTime(11.5);
  expect(f.target(5200).t.mouth).toBe(0);
});

it("le mouvement réduit et un vieux repère audio ne relancent pas de geste", () => {
  const still = new Face(null, { reducedMotion: true }); still.setState("speaking");
  still.setSpeechGesture("question", 1, 0); still.setSpeechTime(0.4);
  expect(still.target(1000).t.lookY).toBe(0);
  const late = new Face(null); late.setState("speaking"); late.setSpeechTime(10);
  late.setSpeechGesture("question", 1, 0);
  expect(late.target(1000).t.lookY).toBe(0);
});
