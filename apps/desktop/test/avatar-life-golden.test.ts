import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AvatarMotion } from "../src/renderer/avatar-motion.ts";
import { boot, type DrawnAvatar } from "./avatar-harness.ts";

// Filet du « vivant » des avatars : une séquence jouée sur chaque dessin réel (horloge fixée, hasard gradué par une
// suite déterministe), les uniformes envoyés au GPU comparés à un enregistrement fait avant la mise en commun du code
// (fixtures/avatar-life-golden.json). Pour le réécrire volontairement : AVATAR_GOLDEN=update npx vitest run <ce test>.
const FIXTURE = new URL("./fixtures/avatar-life-golden.json", import.meta.url);
const IDS = ["pixel", "pixelcat", "iris", "goutte", "oscillo", "gyre", "essaim"];
type Step = { name: string; frames: number; run?: (a: DrawnAvatar) => void; jump?: number };

const steps: Step[] = [
  { name: "repos", frames: 40 },
  { name: "humeur triste", frames: 40, run: a => a.setMood?.(-0.7, 0.5) },
  { name: "humeur sans énergie", frames: 40, run: a => a.setMood?.(0.5, 0.05) },
  { name: "humeur contente", frames: 40, run: a => a.setMood?.(0.8, 0.9) },
  { name: "humeur neutre", frames: 20, run: a => a.setMood?.(0.2, 0.6) },
  { name: "écoute", frames: 30, run: a => { a.setState("listening"); a.setHearing?.(0.8); } },
  { name: "écoute moins forte", frames: 30, run: a => a.setHearing?.(0.1) },
  { name: "réflexion", frames: 30, run: a => a.setState("thinking") },
  { name: "parole forte", frames: 30, run: a => { a.setState("speaking"); a.setLevel(0.9); a.setMouth?.(0.8, 0.3); } },
  { name: "parole faible", frames: 30, run: a => { a.setLevel(0.2); a.setMouth?.(0.2, 0.9); } },
  { name: "niveau hors bornes", frames: 10, run: a => { a.setLevel(7); a.setHearing?.(-3); } },
  { name: "joie pleine", frames: 40, run: a => { a.setLevel(0.4); a.setEmotion("joy", 1, 0); } },
  { name: "colère légère à durée", frames: 50, run: a => a.setEmotion("angry", 0.4, 300) },
  { name: "après la durée", frames: 40 },
  { name: "tristesse", frames: 40, run: a => a.setEmotion("sad", 0.8, 0) },
  { name: "surprise légère", frames: 40, run: a => a.setEmotion("surprised", 0.5, 500) },
  { name: "amour", frames: 40, run: a => a.setEmotion("love", 1, 0) },
  { name: "émotion inconnue", frames: 20, run: a => a.setEmotion("bogus", Number.NaN, 0) },
  { name: "neutre", frames: 30, run: a => a.setEmotion("neutral", 1, 0) },
  { name: "regard", frames: 40, run: a => a.lookAt?.(0.8, -0.5) },
  { name: "regard hors bornes", frames: 20, run: a => a.lookAt?.(3, -9) },
  { name: "regard périmé", frames: 40, jump: 6000 },
  { name: "hochement", frames: 30, run: a => a.cue?.("nod") },
  { name: "oreilles dressées", frames: 30, run: a => a.cue?.("perk") },
  { name: "sursaut", frames: 40, run: a => a.cue?.("startle") },
  { name: "réveil", frames: 30, run: a => a.cue?.("wake") },
  { name: "clic", frames: 40, run: a => a.cue?.("poke") },
  { name: "veille", frames: 40, run: a => a.setState("sleep") },
  { name: "réveil par l'écoute", frames: 30, run: a => a.setState("listening") },
];

/** Suite pseudo-aléatoire déterministe (LCG) : le clignement des yeux prend ses deux branches. */
function lcg(seed = 12345) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function play(id: string, variant: "simple" | "mouvement" | "reduit") {
  const reducedMotion = variant === "reduit";
  const motion = variant === "simple" ? undefined : new AvatarMotion(reducedMotion);
  motion?.setState("speaking");
  const { avatar, values, state } = boot(id, { reducedMotion, motion, random: lcg() });
  avatar.setState("idle");
  const out: Record<string, { digest: string; last: Record<string, number[]> }> = {};
  for (const step of steps) {
    step.run?.(avatar);
    if (step.name === "parole forte") motion?.play("explain", 1, state.clock / 1000);
    if (step.jump) state.clock += step.jump;
    const hash = createHash("sha256");
    for (let i = 0; i < step.frames; i++) {
      state.clock += 16;
      motion?.setTime(state.clock / 1000);
      state.next(state.clock);
      hash.update(JSON.stringify(values));
    }
    out[step.name] = { digest: hash.digest("hex"), last: JSON.parse(JSON.stringify(values)) };
  }
  avatar.destroy();
  return out;
}

const all = () => Object.fromEntries(IDS.flatMap(id => (["simple", "mouvement", "reduit"] as const).map(v => [`${id}/${v}`, play(id, v)])));

if (process.env.AVATAR_GOLDEN === "update") writeFileSync(FIXTURE, JSON.stringify(all()) + "\n");

it.each(IDS)("%s : la séquence du vivant donne les mêmes uniformes que l'enregistrement", (id) => {
  expect(existsSync(FIXTURE)).toBe(true);
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as ReturnType<typeof all>;
  for (const variant of ["simple", "mouvement", "reduit"] as const) {
    const got = play(id, variant), want = golden[`${id}/${variant}`]!;
    expect(Object.keys(got)).toEqual(Object.keys(want));
    for (const name of Object.keys(want)) {
      // Comparaison exacte : aucune tolérance (les nombres JSON reviennent bit pour bit).
      expect({ variant, name, ...got[name]! }).toEqual({ variant, name, ...want[name]! });
    }
  }
});

it("la séquence est déterministe et fait bouger chaque avatar", () => {
  for (const id of IDS) {
    const a = play(id, "mouvement"), b = play(id, "mouvement");
    expect(a).toEqual(b);
    const digests = new Set(Object.values(a).map(s => s.digest));
    expect(digests.size).toBeGreaterThan(20);
    expect(Object.values(a).every(s => Object.values(s.last).flat().every(Number.isFinite))).toBe(true);
  }
});
