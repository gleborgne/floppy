import { it, expect } from "vitest";
import { AvatarMotion } from "../src/renderer/avatar-motion.ts";
import { boot } from "./avatar-harness.ts";

/** Joue le dessin d'un avatar (voir avatar-harness.ts) ; renvoie les derniers uniformes envoyés au GPU. */
function draw(id: string, intent: "none" | "explain" | "playful" | "question", reducedMotion = false, endState = "speaking") {
  const motion = new AvatarMotion(reducedMotion); motion.setState("speaking"); motion.play(intent, 1, 0);
  const { avatar, values, state } = boot(id, { reducedMotion, motion });
  avatar.setState("speaking"); avatar.setLevel(0);
  for (state.clock = 16; state.clock <= 480; state.clock += 16) { motion.setTime(state.clock / 1000); state.next(state.clock); }
  if (endState !== "speaking") {
    motion.setState(endState); avatar.setState(endState);
    for (; state.clock <= 2480; state.clock += 16) { motion.setTime(state.clock / 1000); state.next(state.clock); }
  }
  avatar.destroy(); return values;
}

it.each(["pixel", "pixelcat", "iris", "droplet", "neon-scope", "gyre", "swarm"])("%s interprète les trois intentions, revient au repos et respecte le mouvement réduit", (id) => {
  const baseline = draw(id, "none");
  for (const intent of ["explain", "playful", "question"] as const) {
    const values = draw(id, intent);
    expect(Object.values(values).flat().every(Number.isFinite)).toBe(true);
    expect(values).not.toEqual(baseline);
    expect(draw(id, intent, true)).toEqual(draw(id, "none", true));
    const stopped = draw(id, intent, false, "listening"), resting = draw(id, "none", false, "listening");
    for (const [name, vals] of Object.entries(stopped)) vals.forEach((v, i) => expect(v).toBeCloseTo(resting[name]![i]!, 2));
  }
});
