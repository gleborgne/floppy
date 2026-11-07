import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { AvatarMotion } from "../src/renderer/avatar-motion.ts";

/** Exécute le vrai dessin ; capture les uniformes transmis au GPU, sans dépendre d'un pilote graphique. */
function draw(id: string, intent: "none" | "explain" | "playful" | "question", reducedMotion = false, endState = "speaking") {
  const source = readFileSync(new URL(`../../../plugins/avatar/${id}/renderer/index.js`, import.meta.url), "utf8");
  const names = [...source.matchAll(/uniform\s+\w+\s+([^;]+);/g)].flatMap(m => m[1]!.split(",").map(v => v.trim().replace(/\[.*$/, "")));
  const values: Record<string, number[]> = {};
  let next!: (now: number) => void, clock = 0;
  const gl = new Proxy({}, { get(_target, key) {
    if (key === "getProgramParameter") return (_p: unknown, flag: string) => flag === "ACTIVE_UNIFORMS" ? names.length : true;
    if (key === "getShaderParameter") return () => true;
    if (key === "getActiveUniform") return (_p: unknown, i: number) => ({ name: names[i] });
    if (key === "getUniformLocation") return (_p: unknown, name: string) => name;
    if (String(key).startsWith("uniform")) return (name: string, ...args: unknown[]) => { values[name] = args.flatMap(v => typeof v === "number" ? [v] : Array.from(v as number[])); };
    if (/^[A-Z_0-9]+$/.test(String(key))) return key;
    if (String(key).startsWith("create")) return () => ({});
    return () => {};
  } });
  const canvas = { style: {}, width: 240, height: 240, getContext: () => gl, getBoundingClientRect: () => ({ width: 240, height: 240 }), remove() {} };
  const motion = new AvatarMotion(reducedMotion); motion.setState("speaking"); motion.play(intent, 1, 0);
  const env = { document: { createElement: () => canvas }, window: { devicePixelRatio: 1 }, performance: { now: () => clock },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }), requestAnimationFrame: (fn: typeof next) => { next = fn; return 1; }, cancelAnimationFrame() {},
    create: undefined as unknown as (box: object, opts: object) => { setState(s: string): void; setLevel(v: number): void; destroy(): void } };
  runInNewContext(source.replace(/export (?=function|const)/g, "") + "\nglobalThis.create = create;", env);
  const avatar = env.create({ append() {} }, { reducedMotion, motion }); avatar.setState("speaking"); avatar.setLevel(0);
  for (clock = 16; clock <= 480; clock += 16) { motion.setTime(clock / 1000); next(clock); }
  if (endState !== "speaking") {
    motion.setState(endState); avatar.setState(endState);
    for (; clock <= 2480; clock += 16) { motion.setTime(clock / 1000); next(clock); }
  }
  avatar.destroy(); return values;
}

it.each(["pixel", "pixelcat", "iris", "goutte", "oscillo", "gyre", "essaim"])("%s interprète les trois intentions, revient au repos et respecte le mouvement réduit", (id) => {
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
