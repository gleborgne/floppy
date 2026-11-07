import { it, expect } from "vitest";
import { AvatarMotion } from "../src/renderer/avatar-motion.ts";

it("donne des gestes distincts sur l'horloge audio et reste figé sans nouveau temps de lecture", () => {
  for (const intent of ["explain", "playful", "question"] as const) {
    const motion = new AvatarMotion(); motion.setState("speaking"); motion.play(intent, 1, 10);
    motion.setTime(10); expect(Object.values(motion.sample()).every(v => v === 0)).toBe(true);
    motion.setTime(10.4); const pose = motion.sample();
    expect(pose[intent === "explain" ? "nod" : intent === "playful" ? "smile" : "open"]).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) expect(motion.sample()).toEqual(pose);
    motion.setTime(12); expect(Object.values(motion.sample()).every(v => v === 0)).toBe(true);
  }
});

it("fond les intentions, respecte l'intensité, le délai entre gestes et les repères tardifs", () => {
  const m = new AvatarMotion(), quiet = new AvatarMotion();
  for (const motion of [m, quiet]) { motion.setState("speaking"); motion.setTime(1.4); }
  m.play("question", 1, 1); quiet.play("question", 0.45, 1);
  expect(quiet.sample().open).toBeCloseTo(m.sample().open * 0.45);
  const before = m.sample(); m.play("question", 1, 1.4); expect(m.sample()).toEqual(before);
  m.play("playful", 1, 1.4); expect(m.sample()).toEqual(before);
  m.play("none", 1, 1.4); m.setTime(1.7); expect(m.sample().open).toBe(0);
  m.setTime(8); m.play("explain", 1, 2); expect(m.sample().nod).toBe(0);
});

it("annule à la coupure, en écoute et en mouvement réduit ; l'attention suit les étapes", () => {
  const m = new AvatarMotion(); m.setState("speaking"); m.play("question", 1, 0); m.setTime(0.4);
  expect(m.sample().open).toBeGreaterThan(0);
  m.setAttention("approval"); expect(m.sample().open).toBe(0); expect(m.gaze()).toEqual({ x: 0, y: -0.8 });
  m.setState("listening"); expect(m.gaze()).toEqual({ x: 0, y: 0 });
  m.setState("speaking"); expect(m.sample().open).toBe(0);
  m.play("question", 1, 0); m.play(null); expect(m.sample().open).toBe(0);
  m.setState("thinking"); expect(m.gaze()!.y).toBeLessThan(0);
  m.setState("idle"); expect(m.gaze()).toBeNull();
  const reduced = new AvatarMotion(true); reduced.setState("speaking"); reduced.play("question", 1, 0); reduced.setTime(0.4);
  expect(reduced.sample().open).toBe(0);
});
