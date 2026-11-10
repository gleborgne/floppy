import { describe, it, expect } from "vitest";
import { parseEmotionTag } from "@floppy/protocol";
import { EmotionTagFilter, emotionTagPrompt, filterEvents, PROMPT_EMOTIONS_EN, type FilterOut } from "../src/emotion-tags.ts";

/** Passe les morceaux dans le filtre et rend ce qui en sort, morceaux de texte collés. */
function run(chunks: string[]): FilterOut[] {
  const f = new EmotionTagFilter();
  const all = [...chunks.flatMap((c) => f.push(c)), ...f.end()];
  const out: FilterOut[] = [];
  for (const o of all) {
    const last = out.at(-1);
    if (o.text !== undefined && !o.emotion && last?.text !== undefined && !last.emotion) last.text += o.text;
    else out.push({ ...o });
  }
  return out;
}

describe("étiquettes d'émotion", () => {
  it("en tête, comme avant", () => {
    expect(run(["[joie] Bonne nouvelle !"])).toEqual([{ emotion: "joy" }, { text: "Bonne nouvelle !" }]);
    expect(run(["[jo", "ie]", " Bon", "ne nouvelle"])).toEqual([{ emotion: "joy" }, { text: "Bonne nouvelle" }]);
    expect(run(["[bizarre] Salut"])).toEqual([{ text: "Salut" }]); // mot court inconnu en tête : retiré
    expect(run(["Pas d'étiquette."])).toEqual([{ text: "Pas d'étiquette." }]);
  });

  it("au milieu de la réponse, à sa place", () => {
    expect(run(["[content] C'est fait. [malicieux] Et j'ai rangé."])).toEqual([
      { emotion: "happy" }, { text: "C'est fait. " }, { emotion: "mischief" }, { text: "Et j'ai rangé." },
    ]);
    expect(run(["C'est fait. [surp", "ris] Oh !"])).toEqual([{ text: "C'est fait. " }, { emotion: "surprised" }, { text: "Oh !" }]);
  });

  it("garde les crochets qui ne sont pas des émotions, au milieu", () => {
    expect(run(["Voir la note [1] et [annexe]."])).toEqual([{ text: "Voir la note [1] et [annexe]." }]);
    expect(run(["Un [ tout seul qui dure longtemps, très longtemps."])).toEqual([{ text: "Un [ tout seul qui dure longtemps, très longtemps." }]);
  });

  it("intensité : + forte, - légère, « très », « un peu »", () => {
    expect(run(["[joie+] Youpi"])).toEqual([{ emotion: "joy", intensity: 1.25 }, { text: "Youpi" }]);
    expect(run(["[content-] Bon"])).toEqual([{ emotion: "happy", intensity: 0.45 }, { text: "Bon" }]);
    expect(parseEmotionTag("très surpris")).toEqual({ emotion: "surprised", intensity: 1.25 });
    expect(parseEmotionTag("un peu triste")).toEqual({ emotion: "sad", intensity: 0.45 });
    expect(parseEmotionTag("Désolé")).toEqual({ emotion: "sorry" });
    expect(parseEmotionTag("annexe")).toBeUndefined();
  });

  it("après un outil, l'étiquette de tête peut revenir", () => {
    const f = new EmotionTagFilter();
    expect(f.push("[content] Je cherche.")).toEqual([{ emotion: "happy" }, { text: "Je cherche." }]);
    expect(f.newSegment()).toEqual([]);
    expect(f.push(" [fier] Trouvé !")).toEqual([{ emotion: "proud" }, { text: "Trouvé !" }]);
  });
});

describe("événements du cerveau", () => {
  it("filterEvents : l'émotion à sa place, le texte sans étiquette", () => {
    const f = new EmotionTagFilter();
    expect(filterEvents(f.push("[joie+] Youpi [surpris] oh"))).toEqual([
      { type: "emotion", emotion: "joy", intensity: 1.25 }, { type: "text", delta: "Youpi " },
      { type: "emotion", emotion: "surprised" }, { type: "text", delta: "oh" },
    ]);
  });
});

describe("consigne d'étiquettes", () => {
  it("existe en français et en anglais, avec les noms que le filtre comprend", () => {
    expect(emotionTagPrompt("fr")).toContain("ton émotion entre crochets");
    expect(emotionTagPrompt(undefined)).toContain("ton émotion entre crochets");
    expect(emotionTagPrompt("en")).toContain("emotion in square brackets");
    for (const e of PROMPT_EMOTIONS_EN) expect(parseEmotionTag(e)?.emotion).toBeDefined();
  });
});

describe("liens markdown en tête de segment", () => {
  it("garde le libellé d'un lien en tête", () => {
    expect(run(["[Guide](https://x.y) est ici. "])).toEqual([{ text: "[Guide](https://x.y) est ici. " }]);
  });
  it("lien coupé entre deux morceaux", () => {
    expect(run(["[Guide]", "(https://x.y) ok"])).toEqual([{ text: "[Guide](https://x.y) ok" }]);
  });
  it("lien en tête après newSegment()", () => {
    const f = new EmotionTagFilter();
    f.push("Voici. ");
    f.newSegment();
    expect([...f.push("[Guide](u) là"), ...f.end()]).toEqual([{ text: "[Guide](u) là" }]);
  });
  it("vraie émotion suivie d'un lien", () => {
    expect(run(["[content] [Guide](u)"])).toEqual([{ emotion: "happy" }, { text: "[Guide](u)" }]);
  });
  it("un mot inconnu en tête reste retiré, même seul à la fin", () => {
    expect(run(["[blabla] Bonjour"])).toEqual([{ text: "Bonjour" }]);
    expect(run(["[blabla]"])).toEqual([]);
    const f = new EmotionTagFilter();
    expect(f.push("[blabla]")).toEqual([]);
    expect(f.newSegment()).toEqual([]);
  });
});
