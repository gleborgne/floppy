import { describe, it, expect } from "vitest";
import { EMOTIONS } from "@floppy/protocol";
import { EMOTION_SHEET, emotionInfo, expressivenessFactor } from "../src/emotion-sheet.ts";

describe("fiche des émotions", () => {
  it("décrit chaque émotion du protocole, et seulement elles", () => {
    expect(Object.keys(EMOTION_SHEET).sort()).toEqual([...EMOTIONS].sort());
    for (const e of EMOTIONS) expect(EMOTION_SHEET[e].affect).toHaveLength(2);
  });
  it("valeurs repères", () => {
    expect(EMOTION_SHEET.joy).toMatchObject({ affect: [0.85, 0.8], moves: true, intent: "playful", voice: ["joyeux et lumineux", "joyful and bright"] });
    expect(EMOTION_SHEET.sorry).toMatchObject({ intent: "reassure", gesture: "none", moves: true });
    expect(EMOTION_SHEET.focused).toMatchObject({ intent: "explain", gesture: "explain", moves: false });
    expect(EMOTION_SHEET.curious).toMatchObject({ intent: "explain", gesture: "question" });
    expect(EMOTION_SHEET.neutral.voice).toBeUndefined();
    expect(EMOTIONS.filter((e) => !EMOTION_SHEET[e].moves).sort()).toEqual(["focused", "neutral", "sleepy", "thinking"]);
  });
  it("emotionInfo : un mot inconnu n'a pas de fiche", () => {
    expect(emotionInfo("joy")?.intent).toBe("playful");
    expect(emotionInfo("toString")).toBeUndefined();
    expect(emotionInfo(undefined)).toBeUndefined();
  });
  it("expressivité : discrète 0.45, naturelle 0.8, joueuse 1", () => {
    expect([expressivenessFactor("discreet"), expressivenessFactor("natural"), expressivenessFactor("playful")]).toEqual([0.45, 0.8, 1]);
  });
});
