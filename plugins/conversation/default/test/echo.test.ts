import { describe, it, expect } from "vitest";
import { isEcho, words } from "../src/echo.ts";

describe("écho de la voix de Floppy", () => {
  const said = ["Je peux aussi te résumer une de tes discussions de groupe de cet après-midi, par exemple le Daily Feature Team ou le Daily core team."];
  it("mots sans accents ni ponctuation", () => {
    expect(words("Déjà, l'après-midi !")).toEqual(["deja", "l", "apres", "midi"]);
  });
  it("un morceau déformé de la réponse est un écho", () => {
    expect(isEcho("le daily feature team ou le dély core team", said)).toBe(true);
  });
  it("une vraie demande n'est pas un écho", () => {
    expect(isEcho("non, lis-moi plutôt mes mails", said)).toBe(false);
  });
  it("un mot seul n'est jamais un écho ; deux mots seulement s'ils se suivent", () => {
    expect(isEcho("daily", said)).toBe(false);
    expect(isEcho("core team", said)).toBe(true);
    expect(isEcho("team daily", said)).toBe(false);
  });
  it("rien de dit : pas d'écho", () => {
    expect(isEcho("bonjour à toi", [])).toBe(false);
  });
});
