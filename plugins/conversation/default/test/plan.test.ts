// Plan d'une phrase : une fonction pure qui rassemble émotion, geste, silence de paragraphe et livraison à la voix.
import { describe, expect, it } from "vitest";
import { EmotionSettler } from "../src/settle.ts";
import { deliveryFor, planSentence } from "../src/plan.ts";

const base = { request: "", profile: "natural" as const, language: "fr" as const, tone: "cordial" };
const plan = (settler: EmotionSettler, text: string, tag?: { emotion: string; intensity?: number }, extra: { paragraph?: boolean; request?: string; profile?: "discreet" | "natural" | "playful" } = {}) =>
  planSentence({ ...base, ...extra, text, settled: settler.next(tag), paragraph: extra.paragraph ?? false });

describe("planSentence", () => {
  it("étiquette en tête : émotion, expression et livraison portent la même émotion", () => {
    const p = plan(new EmotionSettler(), "Bonjour !", { emotion: "happy", intensity: 0.8 });
    expect(p.emotion).toBe("happy");
    expect(p.intensity).toBe(0.8);
    expect(p.cue).toEqual({ emotion: "happy", intensity: 0.8 });
    expect(p.settling).toBeUndefined();
    expect(p.delivery).toEqual(deliveryFor({ emotion: "happy", intensity: 0.8, profile: "natural", language: "fr", tone: "cordial" }));
    expect(p.delivery).toMatchObject({ emotion: "happy", intensity: 0.8, profile: "natural", language: "fr", tone: "cordial" });
  });

  it("l'émotion s'apaise sur les phrases suivantes, puis le visage redescend une fois", () => {
    const s = new EmotionSettler();
    const a = plan(s, "Un.", { emotion: "happy" });
    const b = plan(s, "Deux.");
    const c = plan(s, "Trois.");
    const d = plan(s, "Quatre.");
    const e = plan(s, "Cinq.");
    expect(a.settling).toBeUndefined();
    expect(b).toMatchObject({ emotion: "happy", settling: true, cue: { emotion: "happy" } });
    expect(b.intensity).toBeCloseTo(0.6);
    expect(c.intensity).toBeCloseTo(0.36);
    expect(d.emotion).toBeUndefined();
    expect(d.cue).toEqual({ emotion: "neutral" });
    expect(d.settling).toBe(true);
    expect(d.delivery.intent).toBe("neutral");
    expect(d.delivery.emotion).toBeUndefined();
    expect(e.cue).toBeUndefined();
    expect(e.settling).toBeUndefined();
  });

  it("une nouvelle étiquette en cours de réponse remplace l'apaisement", () => {
    const s = new EmotionSettler();
    plan(s, "Un.", { emotion: "happy" });
    plan(s, "Deux.");
    const c = plan(s, "Trois.", { emotion: "sad", intensity: 1 });
    expect(c).toMatchObject({ emotion: "sad", intensity: 1, cue: { emotion: "sad", intensity: 1 } });
    expect(c.settling).toBeUndefined();
  });

  it("sans étiquette, ni expression ni émotion", () => {
    const p = plan(new EmotionSettler(), "Une phrase.");
    expect(p.cue).toBeUndefined();
    expect(p.emotion).toBeUndefined();
    expect(p.delivery).toEqual({ intent: "neutral", profile: "natural", language: "fr", tone: "cordial" });
  });

  it("le silence de paragraphe suit le drapeau", () => {
    expect(plan(new EmotionSettler(), "A.", undefined, { paragraph: true }).pauseBefore).toBe(true);
    expect(plan(new EmotionSettler(), "A.").pauseBefore).toBe(false);
  });

  it("geste tiré du texte (question) ou de l'émotion (rôle de la fiche)", () => {
    expect(plan(new EmotionSettler(), "Tu viens ?").gesture.intent).toBe("question");
    expect(plan(new EmotionSettler(), "Il fait beau.").gesture.intent).toBe("none");
    expect(plan(new EmotionSettler(), "Il fait beau.", { emotion: "laugh" }).gesture.intent).toBe("playful");
    expect(plan(new EmotionSettler(), "Il fait beau.", { emotion: "focused" }).gesture.intent).toBe("explain");
    expect(plan(new EmotionSettler(), "Tu viens ?", { emotion: "sad" }).gesture.intent).toBe("none");
    expect(plan(new EmotionSettler(), "Voilà.", undefined, { request: "raconte une blague" }).gesture.intent).toBe("playful");
  });

  it("le texte envoyé à la voix est la forme parlée, dans la langue du plan ; le geste suit le texte écrit", () => {
    expect(plan(new EmotionSettler(), "RDV à 14:30, 20% de remise ?").text).toBe("RDV à 14 h 30, 20 pour cent de remise ?");
    const en = planSentence({ ...base, language: "en", text: "Meet at 14:30.", settled: new EmotionSettler().next(), paragraph: false });
    expect(en.text).toBe("Meet at 2:30 PM.");
    expect(plan(new EmotionSettler(), "Vois https://contoso.com/x ?").gesture.intent).toBe("question");
  });

  it("le profil d'expressivité règle l'intensité du geste", () => {
    const g = (profile: "discreet" | "natural" | "playful") => plan(new EmotionSettler(), "Oui ?", undefined, { profile }).gesture.intensity;
    expect(g("discreet")).toBeLessThan(g("natural"));
    expect(g("natural")).toBeLessThanOrEqual(g("playful"));
    expect(plan(new EmotionSettler(), "Oui ?", undefined, { profile: "discreet" }).delivery.profile).toBe("discreet");
  });
});
