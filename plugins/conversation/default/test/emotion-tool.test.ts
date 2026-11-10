import { describe, it, expect } from "vitest";
import { PROMPT_EMOTIONS_EN } from "@floppy/contracts";
import { EMOTION_TOOL, emotionToolInfo, parseEmotionCall } from "../src/emotion-tool.ts";

describe("outil d'émotion du Live", () => {
  it("déclaration : les douze noms stables, trois niveaux, en lecture seule", () => {
    const t = emotionToolInfo();
    expect(t).toMatchObject({ name: EMOTION_TOOL, level: "read" });
    const props = (t.inputSchema as { properties: Record<string, { enum: string[] }>; required: string[] });
    expect(props.properties.emotion!.enum).toEqual([...PROMPT_EMOTIONS_EN]);
    expect(props.properties.intensite!.enum).toEqual(["legere", "normale", "forte"]);
    expect(props.required).toEqual(["emotion"]);
  });
  it("lecture d'un appel : intensité légère, normale, forte ; inconnu ou vide ignoré", () => {
    expect(parseEmotionCall({ emotion: "joy", intensite: "legere" })).toEqual({ emotion: "joy", intensity: 0.45 });
    expect(parseEmotionCall({ emotion: "Joy", intensite: "normale" })).toEqual({ emotion: "joy" });
    expect(parseEmotionCall({ emotion: "sad", intensite: "forte" })).toEqual({ emotion: "sad", intensity: 1.25 });
    expect(parseEmotionCall({ emotion: "joie" })).toBeUndefined(); // seuls les noms stables en anglais
    expect(parseEmotionCall({ emotion: "neutral" })).toBeUndefined();
    expect(parseEmotionCall({})).toBeUndefined();
  });
});
