// Découpe en phrases : les abréviations, initiales et numéros de liste ne coupent pas la phrase (texte poussé en flux).
import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "../src/text.ts";

/** Pousse le texte par petits morceaux de 3 caractères, puis vide : toutes les phrases dans l'ordre. */
function stream(text: string, size = 3): string[] {
  const s = new SentenceSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.flush());
  return out;
}

describe("SentenceSplitter : abréviations", () => {
  const cases: [string, string, string][] = [
    ["M.", "Bonjour tout le monde. Je parle à M. Dupont aujourd'hui même. Et ensuite nous partons.", "Je parle à M. Dupont aujourd'hui même."],
    ["Mme.", "Bonjour tout le monde. Voici Mme. Martin qui nous accompagne ce soir. Merci beaucoup à tous.", "Voici Mme. Martin qui nous accompagne ce soir."],
    ["Dr.", "Bonjour tout le monde. Le Dr. Durand arrive demain matin très tôt. Merci beaucoup à tous.", "Le Dr. Durand arrive demain matin très tôt."],
    ["etc.", "Bonjour tout le monde. J'achète du pain, du lait, etc. pour la semaine entière. Merci beaucoup à tous.", "J'achète du pain, du lait, etc. pour la semaine entière."],
    ["p. ex.", "Bonjour tout le monde. Choisis un fruit, p. ex. une pomme bien mûre. Merci beaucoup à tous.", "Choisis un fruit, p. ex. une pomme bien mûre."],
    ["cf.", "Bonjour tout le monde. Voir la note, cf. le chapitre trois du livre. Merci beaucoup à tous.", "Voir la note, cf. le chapitre trois du livre."],
    ["Mr.", "Hello everyone here. I met Mr. Smith yesterday at the station. Thanks a lot everyone.", "I met Mr. Smith yesterday at the station."],
    ["Mrs.", "Hello everyone here. I met Mrs. Jones yesterday at the station. Thanks a lot everyone.", "I met Mrs. Jones yesterday at the station."],
    ["e.g.", "Hello everyone here. Pick a fruit, e.g. a ripe apple from the tree. Thanks a lot everyone.", "Pick a fruit, e.g. a ripe apple from the tree."],
    ["i.e.", "Hello everyone here. Pick the red one, i.e. the ripe apple from the tree. Thanks a lot everyone.", "Pick the red one, i.e. the ripe apple from the tree."],
    ["vs.", "Hello everyone here. It is cats vs. dogs again in this debate today. Thanks a lot everyone.", "It is cats vs. dogs again in this debate today."],
    ["initiale", "Bonjour tout le monde. J'ai écrit à J. Dupont pour lui répondre vite. Merci beaucoup à tous.", "J'ai écrit à J. Dupont pour lui répondre vite."],
    ["initial en", "Hello everyone here. I wrote to J. Smith to answer him quickly. Thanks a lot everyone.", "I wrote to J. Smith to answer him quickly."],
    ["n°", "Bonjour tout le monde. Appelle le n° 5 de la rue principale ce soir. Merci beaucoup à tous.", "Appelle le n° 5 de la rue principale ce soir."],
  ];
  for (const [name, text, kept] of cases) {
    it(`« ${name} » ne coupe pas la phrase`, () => {
      const parts = stream(text);
      expect(parts).toContain(kept);
      expect(parts.join(" ")).toBe(text);
    });
  }

  it("numéro de liste : « 1. Faire » reste avec son texte, en début de réponse comme après un retour à la ligne", () => {
    expect(stream("1. Faire les courses ce matin\n2. Préparer le repas du soir\n")[0]).toBe("1. Faire les courses ce matin 2. Préparer le repas du soir");
    expect(stream("Voici la liste complète :\n1. Faire les courses ce matin. Puis le reste.")).toEqual([
      "Voici la liste complète :",
      "1. Faire les courses ce matin.",
      "Puis le reste.",
    ]);
  });

  it("une vraie fin de phrase coupe toujours, et la 1re phrase part tôt", () => {
    expect(stream("Bonjour. Il fait beau aujourd'hui sur toute la région. Bonne journée à vous.")).toEqual([
      "Bonjour.", "Il fait beau aujourd'hui sur toute la région.", "Bonne journée à vous.",
    ]);
    // Une 1re phrase qui finit par une abréviation attend la suite du texte pour se couper.
    const s = new SentenceSplitter();
    expect(s.push("Je vois M. ")).toEqual([]);
    expect(s.push("Dupont demain. ")).toEqual(["Je vois M. Dupont demain."]);
  });

  it("l'abréviation en fin de morceau attend le mot suivant (flux lettre par lettre)", () => {
    expect(stream("Je vois le Dr. Durand demain. Puis nous mangeons ensemble.", 1)).toEqual(["Je vois le Dr. Durand demain.", "Puis nous mangeons ensemble."]);
  });
});

it("une phrase qui finit par un mot d'une lettre en minuscule est bien coupée", () => {
  const s = new SentenceSplitter();
  expect(s.push("Voilà tout ce qu'il y a. Ensuite on regarde le reste. ")).toEqual(["Voilà tout ce qu'il y a.", "Ensuite on regarde le reste."]);
});
