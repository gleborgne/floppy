import { it, expect } from "vitest";
import { speechInstructions, speechStyle } from "../src/speech-delivery.ts";

const expressive = { intent: "neutral", profile: "playful", language: "fr" } as const;
it.each([
  ["happy", "satisfait", "pleased"], ["proud", "fier", "proud"],
  ["surprised", "surpris", "surprised"], ["relieved", "soulagé", "relieved"],
])("conserve la couleur %s dans les deux langues", (emotion, fr, en) => {
  expect(speechInstructions({ ...expressive, emotion })).toContain(fr);
  expect(speechInstructions({ ...expressive, emotion, language: "en" })).toContain(en);
});
it("module le jeu sans rendre le profil discret théâtral, et borne les valeurs invalides", () => {
  const d = { ...expressive, emotion: "surprised" };
  expect(speechStyle({ ...d, intensity: 0.45 }, "en")).toBe("slightly surprised");
  expect(speechStyle({ ...d, intensity: 1.25 }, "en")).toBe("very surprised");
  expect(speechStyle({ ...d, intensity: 1.25, profile: "discreet" }, "en")).not.toContain("very");
  expect(speechStyle({ ...d, intensity: 0 })).toBe("");
  expect(speechStyle({ ...d, intensity: -1 })).toBe("");
  expect(speechStyle({ ...d, intensity: NaN }, "en")).toBe("surprised");
  expect(speechStyle({ ...d, emotion: "[laughs] texte injecté" })).not.toContain("injecté");
  expect(speechStyle({ ...d, emotion: "constructor" })).not.toContain("function");
});
it("la réassurance prime sur une émotion forte ou contradictoire", () => {
  const d = { ...expressive, intent: "reassure", emotion: "excited", intensity: 1.5, tone: "sarcastique" } as const;
  expect(speechStyle(d, "en")).toBe("soft tone");
  expect(speechInstructions(d)).not.toMatch(/enthousiaste|sarcastique/);
});

it("rassurer reste calme même avec le profil joueur et un ton sarcastique", () => {
  const s = speechInstructions({ intent: "reassure", profile: "playful", language: "fr", tone: "Très sarcastique" });
  expect(s).toContain("calme"); expect(s).not.toContain("Très sarcastique"); expect(s).not.toContain("contrastes expressifs");
});
it("les consignes suivent la langue, l'intention et le profil sans changer les mots à dire", () => {
  expect(speechInstructions({ intent: "playful", profile: "playful", language: "en" })).toContain("friendly mischief");
  expect(speechInstructions({ intent: "explain", profile: "discreet", language: "fr" })).toContain("discrète");
  expect(speechInstructions({ intent: "neutral", profile: "natural", language: "fr" })).toContain("mesurée");
});
