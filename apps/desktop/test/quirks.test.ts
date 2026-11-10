import { describe, it, expect } from "vitest";
import { chooseQuirk, type Quirk, type QuirkContext } from "../src/renderer/quirks.ts";

const base: QuirkContext = { valence: 0.2, energy: 0.6, aloneMs: 20000, kernelEmotion: "neutral", kernelAgoMs: 1e9, random: () => 0 };
/** Premier tirage fixe pour le choix, 0.5 pour le reste (coordonnées du regard). */
const pick = (c: Partial<QuirkContext>, r: number): Quirk => { let n = 0; return chooseQuirk({ ...base, ...c, random: () => (n++ === 0 ? r : 0.5) }); };
const name = (q: Quirk): string => (q.kind === "flash" ? q.name : q.kind === "cue" ? `cue:${q.name}` : q.kind);
const draws = Array.from({ length: 100 }, (_, i) => i / 100);
const sweep = (c: Partial<QuirkContext>): Set<string> => new Set(draws.map((r) => name(pick(c, r))));
const PLAYFUL = ["mischief", "wink", "happy"];

describe("manies au repos", () => {
  it("humeur neutre : chaque manie existante reste possible, avec leurs durées et intensités", () => {
    expect(sweep({})).toEqual(new Set(["look", "curious", "happy", "mischief", "wink", "cue:perk"]));
    expect(pick({}, 0.1)).toMatchObject({ kind: "look", x: 0 });
    expect(pick({}, 0.4)).toEqual({ kind: "flash", name: "curious", ms: 1500, intensity: 0.6 });
    expect(pick({}, 0.5)).toEqual({ kind: "flash", name: "happy", ms: 2200, intensity: 0.5, cue: "nod" });
    expect(pick({}, 0.7)).toEqual({ kind: "flash", name: "mischief", ms: 900, intensity: 0.6 });
    expect(pick({}, 0.8)).toEqual({ kind: "flash", name: "wink", ms: 650, intensity: 1 });
    expect(pick({}, 0.9)).toEqual({ kind: "cue", name: "perk" });
  });
  it("énergie basse : bâillement en tête, comme avant", () => {
    expect(pick({ energy: 0.2 }, 0.3)).toEqual({ kind: "flash", name: "tired", ms: 1900, intensity: 1.2 });
  });
  it("seul depuis plus de trois minutes : il s'ennuie", () => {
    expect(pick({ aloneMs: 200000 }, 0.2)).toEqual({ kind: "flash", name: "bored", ms: 2600, intensity: 0.7 });
  });
  it("humeur nettement négative : ni malice, ni clin d'œil, ni chantonnement", () => {
    const seen = sweep({ valence: -0.6 });
    for (const p of PLAYFUL) expect(seen.has(p)).toBe(false);
    expect(seen.has("look")).toBe(true);
    expect(seen.has("none")).toBe(true);
    expect(pick({ valence: -0.6 }, 0.7)).toEqual({ kind: "flash", name: "sad", ms: 1800, intensity: 0.35 });
    expect(pick({ valence: -0.6 }, 0.5)).toEqual({ kind: "flash", name: "tired", ms: 1900, intensity: 0.6 });
  });
  it("bonne humeur : les manies joueuses sont plus probables", () => {
    const share = (c: Partial<QuirkContext>) => draws.filter((r) => PLAYFUL.includes(name(pick(c, r)))).length;
    expect(share({ valence: 0.8 })).toBeGreaterThan(share({}));
  });
  it.each(["sorry", "sad", "confused", "annoyed", "angry", "scared", "cry"])("%s il y a moins d'une minute : aucune manie joueuse", (kernelEmotion) => {
    const seen = sweep({ kernelEmotion, kernelAgoMs: 30000, valence: 0.8 });
    for (const p of PLAYFUL) expect(seen.has(p)).toBe(false);
  });
  it("une émotion négative vieille de plus d'une minute n'empêche plus rien", () => {
    expect(sweep({ kernelEmotion: "angry", kernelAgoMs: 61000 }).has("wink")).toBe(true);
  });
  it("une émotion positive récente ne bloque rien", () => {
    expect(sweep({ kernelEmotion: "joy", kernelAgoMs: 1000 }).has("wink")).toBe(true);
  });
});
