import { it, expect } from "vitest";
import { speechInstructions } from "../src/speech-delivery.ts";

it("rassurer reste calme même avec le profil joueur et un ton sarcastique", () => {
  const s = speechInstructions({ intent: "reassure", profile: "playful", language: "fr", tone: "Très sarcastique" });
  expect(s).toContain("calme"); expect(s).not.toContain("Très sarcastique"); expect(s).not.toContain("contrastes expressifs");
});
it("les consignes suivent la langue, l'intention et le profil sans changer les mots à dire", () => {
  expect(speechInstructions({ intent: "playful", profile: "playful", language: "en" })).toContain("friendly mischief");
  expect(speechInstructions({ intent: "explain", profile: "discreet", language: "fr" })).toContain("discrète");
  expect(speechInstructions({ intent: "neutral", profile: "natural", language: "fr" })).toContain("mesurée");
});
