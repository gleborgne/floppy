import { describe, it, expect } from "vitest";
import { parseEvent, answerTarget, parseChoice } from "../src/chat.ts";

describe("floppy chat", () => {
  it("ignore un message illisible au lieu de planter", () => {
    expect(parseEvent("pas du json")).toBeUndefined();
    expect(parseEvent("42")).toBeUndefined();
    expect(parseEvent("null")).toBeUndefined();
    expect(parseEvent('{"type":"welcome"}')).toEqual({ type: "welcome" });
  });
  it("un numéro choisit l'option correspondante ; le reste n'est pas une réponse", () => {
    const ids = ["a", "b", "c"];
    expect(parseChoice("1", ids)).toBe("a");
    expect(parseChoice("3", ids)).toBe("c");
    expect(parseChoice("0", ids)).toBeUndefined();
    expect(parseChoice("4", ids)).toBeUndefined();
    expect(parseChoice("oui", ids)).toBeUndefined();
    expect(parseChoice("1 2", ids)).toBeUndefined();
  });
  it("« o/n » répond à la dernière demande montrée", () => {
    const pending = ["a", "b"];
    expect(answerTarget(pending)).toBe("b");
    expect(pending).toEqual(["a"]);
  });
});
