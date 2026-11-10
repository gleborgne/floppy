import { describe, it, expect } from "vitest";
import { isRepeatRequest } from "../src/repeat.ts";

const wake = ["floppy"];

describe("commande locale « répète »", () => {
  it.each([
    "répète", "Répète !", "redis", "Redis-le", "tu peux répéter", "Répète, s'il te plaît ?", "pardon ?", "Floppy, répète",
    "peux-tu répéter", "répète-moi ça", "repeat", "Repeat that", "say that again", "Say it again please", "come again", "come again?",
    "can you repeat that", "Floppy, say that again", "hey floppy repeat",
  ])("« %s » demande de répéter", (text) => {
    expect(isRepeatRequest(text, wake)).toBe(true);
  });

  it.each([
    "répète après moi bonjour tout le monde", "répète après moi", "tu peux répéter après moi", "repeat after me", "can you repeat the question about the weather",
    "dis-moi l'heure", "quelle heure est-il", "encore", "say hello", "raconte une histoire", "", "Floppy", "tu peux me répéter la recette de la tarte aux pommes",
  ])("« %s » n'est pas une demande de répétition", (text) => {
    expect(isRepeatRequest(text, wake)).toBe(false);
  });
});

describe("répète : politesse longue et mots ambigus", () => {
  it("« Tu peux répéter, s'il te plaît ? » est reconnu", () => {
    expect(isRepeatRequest("Tu peux répéter, s'il te plaît ?", ["Floppy"])).toBe(true);
  });
  it("« Comment ça ? » demande une explication, pas une répétition", () => {
    expect(isRepeatRequest("Comment ça ?", ["Floppy"])).toBe(false);
    expect(isRepeatRequest("Comment ?", ["Floppy"])).toBe(true);
    expect(isRepeatRequest("Pardon ?", ["Floppy"])).toBe(true);
  });
});
