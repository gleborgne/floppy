import { describe, it, expect } from "vitest";
import { languageName, languageNote, itemLanguageNote } from "../src/renderer/language-note.ts";

describe("note de langue d'un modèle", () => {
  it("nomme la langue dans la langue de la fenêtre", () => {
    expect(languageName("fr", "fr")).toBe("Français");
    expect(languageName("fr", "en")).toBe("French");
    expect(languageName("en", "fr")).toBe("Anglais");
  });

  it("dit la note dans les deux langues", () => {
    expect(languageNote("good", "fr", "fr")).toEqual({ text: "Français : bien", tone: "plain", level: "good" });
    expect(languageNote("fair", "fr", "en")).toEqual({ text: "French: fair", tone: "plain", level: "fair" });
  });

  it("une langue mal gérée passe en jaune", () => {
    expect(languageNote("poor", "fr", "fr")).toEqual({ text: "Français : mal", tone: "warn", level: "poor" });
  });

  it("langue inconnue pour ce modèle : rien à montrer", () => {
    expect(languageNote(undefined, "fr", "fr")).toBeNull();
    expect(languageNote("great", "fr", "fr")).toBeNull();
    expect(itemLanguageNote({ en: "good" }, "fr", "fr")).toBeNull();
    expect(itemLanguageNote(undefined, "fr", "fr")).toBeNull();
  });

  it("lit la note de l'élément pour la langue de l'utilisateur", () => {
    expect(itemLanguageNote({ fr: "fair", en: "good" }, "en", "fr")?.text).toBe("Anglais : bien");
  });
});
