import { describe, it, expect } from "vitest";
import { SpeechExpressions } from "../src/renderer/speech-expressions.ts";

describe("expressions sur l'horloge de lecture", () => {
  it("attend chaque phrase, même si toute la réponse arrive avant sa lecture", () => {
    const queue = new SpeechExpressions();
    const shown: string[] = [];
    const show = (e: { emotion: string }) => shown.push(e.emotion);
    queue.mark({ emotion: "happy" }); queue.audio(0.04);
    queue.audio(1);
    queue.mark({ emotion: "mischief" }); queue.audio(2.5);
    queue.tick(0, show); expect(shown).toEqual([]);
    queue.tick(0.04, show); expect(shown).toEqual(["happy"]);
    queue.tick(2.49, show); expect(shown).toEqual(["happy"]);
    queue.tick(2.5, show); expect(shown).toEqual(["happy", "mischief"]);
  });
  it("une interruption annule les expressions programmées et celles sans audio", () => {
    const queue = new SpeechExpressions();
    queue.mark({ emotion: "happy" }); queue.audio(10);
    queue.mark({ emotion: "angry" }); queue.clear(); queue.audio(20);
    const shown: unknown[] = [];
    queue.tick(30, e => shown.push(e)); expect(shown).toEqual([]);
    queue.mark({ emotion: "curious", intensity: 0.5 }); queue.audio(31);
    queue.tick(31, e => shown.push(e)); expect(shown).toEqual([{ emotion: "curious", intensity: 0.5 }]);
  });
  it("reprend sur la dernière expression après une suspension de la fenêtre", () => {
    const queue = new SpeechExpressions();
    queue.mark({ emotion: "happy" }); queue.audio(1);
    queue.mark({ emotion: "sad" }); queue.audio(2);
    const shown: unknown[] = [];
    queue.tick(3, e => shown.push(e)); expect(shown).toEqual([{ emotion: "sad" }]);
  });
});
