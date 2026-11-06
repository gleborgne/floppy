import { describe, it, expect } from "vitest";
import { parseEvent, answerTarget } from "../src/chat.ts";

describe("floppy chat", () => {
  it("ignore un message illisible au lieu de planter", () => {
    expect(parseEvent("pas du json")).toBeUndefined();
    expect(parseEvent("42")).toBeUndefined();
    expect(parseEvent("null")).toBeUndefined();
    expect(parseEvent('{"type":"welcome"}')).toEqual({ type: "welcome" });
  });
  it("« o/n » répond à la dernière demande montrée", () => {
    const pending = ["a", "b"];
    expect(answerTarget(pending)).toBe("b");
    expect(pending).toEqual(["a"]);
  });
});
