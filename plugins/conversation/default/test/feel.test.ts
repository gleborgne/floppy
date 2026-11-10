import { describe, it, expect } from "vitest";
import { guessEmotion } from "../src/index.ts";

describe("réactions par mots-clés : mot nié", () => {
  it.each([
    "c'est pas génial", "ce n'est pas très génial", "c'est pas vraiment excellent", "c'est pas trop bien joué",
    "ce n'est plus génial", "c'est jamais parfait", "aucun bravo ici", "ce n'est pas du tout génial",
    "it's not great", "this isn't great", "it wasn't excellent", "that's not very good job", "it's not so amazing",
    "I don't think it's awesome", "never perfect", "no thanks",
  ])("« %s » : pas de réaction", (text) => {
    // Pas de réaction du tout, et surtout pas l'émotion contraire.
    expect(guessEmotion(text, "user")).toBeUndefined();
  });
  it("ne compte pas la règle niée et passe aux suivantes", () => {
    expect(guessEmotion("c'est pas génial mais merci", "user")?.emotion).toBe("happy");
    expect(guessEmotion("it's not great, thanks", "user")?.emotion).toBe("happy");
  });
  it("garde les réactions positives, avec ou sans autre négation dans la phrase", () => {
    expect(guessEmotion("merci", "user")?.emotion).toBe("happy");
    expect(guessEmotion("bravo !", "user")?.emotion).toBe("proud");
    expect(guessEmotion("génial !", "user")?.emotion).toBe("proud");
    expect(guessEmotion("c'est encore plus génial", "user")?.emotion).toBe("proud");
    expect(guessEmotion("je ne sais pas, mais bravo", "user")?.emotion).toBe("proud");
    expect(guessEmotion("great job, I'm not kidding", "user")?.emotion).toBe("proud");
    expect(guessEmotion("no way, wow", "user")?.emotion).toBe("surprised");
  });
  it("même règle pour les phrases de Floppy (Live)", () => {
    expect(guessEmotion("Ce n'est pas génial.", "reply")).toBeUndefined();
    expect(guessEmotion("It's not great.", "reply")).toBeUndefined();
    expect(guessEmotion("C'est génial !", "reply")?.emotion).toBe("joy");
    expect(guessEmotion("It's great!", "reply")?.emotion).toBe("joy");
  });
});
