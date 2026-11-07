import { describe, expect, it } from "vitest";
// @ts-expect-error Le dessin WebGL est chargé directement comme module JavaScript.
import { GLOW, paint } from "../renderer/index.js";

const pose = {
  t: 0, hx: 16, hy: 13, by: 24, ears: "up", eyes: "open", mouth: "w",
  tail: [1, 1.5, 1.4], puff: 0, perk: 0, gx: 0, gy: 0, blink: false, level: 0,
  glyph: "",
};
function draw(changes: Partial<typeof pose> = {}) {
  const pixels = new Uint8Array(32 * 32);
  paint(pixels, { ...pose, ...changes });
  return pixels;
}
function eyePixels(pixels: Uint8Array, right: boolean) {
  const found: [number, number, number][] = [];
  for (let y = 8; y < 17; y++) for (let x = right ? 16 : 7; x < (right ? 25 : 16); x++) {
    const color = pixels[y * 32 + x]!;
    if ([6, 7, 8].includes(color)) found.push([x, y, color]);
  }
  return found;
}

describe("chat pixel chibi", () => {
  it("garde une grande tête, de petites oreilles, des joues roses et un corps compact", () => {
    const pixels = draw();
    const sprite = Array.from({ length: 32 }, (_, y) =>
      Array.from(pixels.slice(y * 32, y * 32 + 32), c => c ? String(c) : ".").join(""),
    ).join("\n");
    expect(sprite).toMatchSnapshot();
    // Les joues restent visibles sous les yeux.
    for (const x of [9, 10, 21, 22]) expect(pixels[15 * 32 + x]).toBe(5);
  });

  it.each(["open", "big", "lookup"])("%s : deux yeux surtout sombres, avec un petit reflet", eyes => {
    const pixels = draw({ eyes });
    for (const right of [false, true]) {
      const eye = eyePixels(pixels, right);
      expect(eye.filter(p => p[2] === 7)).toHaveLength(1);
      expect(eye.filter(p => p[2] === 8).length).toBeGreaterThan(eye.length / 2);
    }
    expect(eyePixels(pixels, false).map(([x, y, c]) => [x + 8, y, c])).toEqual(eyePixels(pixels, true));
  });

  it.each(["open", "big", "lookup"])("%s : les deux yeux suivent la même direction, sans loucher", eyes => {
    const base = draw({ eyes });
    for (const gx of [-1, 1]) for (const right of [false, true]) {
      const moved = draw({ eyes, gx });
      expect(eyePixels(moved, right)).toEqual(eyePixels(base, right).map(([x, y, c]) => [x + gx, y, c]));
    }
    if (eyes !== "lookup") for (const gy of [-1, 1]) for (const right of [false, true]) {
      expect(eyePixels(draw({ eyes, gy }), right)).toEqual(eyePixels(base, right).map(([x, y, c]) => [x, y + gy, c]));
    }
  });

  it.each(["open", "big", "lookup", "happy", "heart", "sad", "narrow", "confused", "wink", "closed"])(
    "%s : aucune lueur dans les yeux ou sur le visage", eyes => {
      const pixels = draw({ eyes, glyph: "heart" });
      for (let y = 8; y < 19; y++) for (let x = 7; x < 25; x++) expect(GLOW.has(pixels[y * 32 + x])).toBe(false);
      expect(Array.from(pixels).some(c => GLOW.has(c))).toBe(true); // le signe garde sa lumière
    },
  );

  it.each(["open", "big", "lookup", "sad", "narrow", "confused"])("%s : le clignement ferme les deux yeux", eyes => {
    const pixels = draw({ eyes, blink: true });
    expect(eyePixels(pixels, false)).toEqual([]);
    expect(eyePixels(pixels, true)).toEqual([]);
    expect(pixels).toEqual(draw({ eyes: "closed" }));
  });

  it("préserve le clin d'œil, le sommeil et la bouche qui suit la voix", () => {
    const wink = draw({ eyes: "wink" });
    expect(eyePixels(wink, false).length).toBeGreaterThan(0);
    expect(eyePixels(wink, true)).toHaveLength(0);
    expect(draw({ eyes: "closed", ears: "down" })).not.toEqual(draw());
    expect(draw({ mouth: "open", level: 0.8 })).not.toEqual(draw({ mouth: "open", level: 0 }));
  });
});
