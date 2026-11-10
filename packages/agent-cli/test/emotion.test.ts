import { describe, it, expect } from "vitest";
import { ReplyTags, withEmotionTags } from "../src/emotion.ts";

describe("étiquettes d'émotion des cerveaux CLI", () => {
  it("ajoute la consigne à la fin du prompt dans la langue de l'assistant, ou rien si coupé", () => {
    expect(withEmotionTags("Base.", false, "fr")).toBe("Base.");
    expect(withEmotionTags("Base.", true, "fr")).toMatch(/^Base\.\n\nCommence ta réponse par ton émotion entre crochets/);
    expect(withEmotionTags("Base.", true, "en")).toMatch(/^Base\.\n\nStart your answer with your emotion in square brackets/);
  });
  it("filtre le flux : émotion à sa place, étiquette coupée entre deux morceaux, segments", () => {
    const tags = new ReplyTags(true);
    const out = [...tags.push("[jo"), ...tags.push("ie] Bon"), ...tags.push("jour [1]"), ...tags.newSegment(), ...tags.push("[fier] Fait"), ...tags.end()];
    expect(out).toEqual([
      { type: "emotion", emotion: "joy" }, { type: "text", delta: "Bon" }, { type: "text", delta: "jour [1]" },
      { type: "emotion", emotion: "proud" }, { type: "text", delta: "Fait" },
    ]);
  });
  it("coupé : le texte passe tel quel", () => {
    const tags = new ReplyTags(false);
    expect(tags.push("[joie] Salut")).toEqual([{ type: "text", delta: "[joie] Salut" }]);
    expect(tags.newSegment()).toEqual([]);
    expect(tags.end()).toEqual([]);
  });
});
