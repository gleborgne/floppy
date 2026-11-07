import { describe, it, expect } from "vitest";
import { CliConversation } from "../src/conversation.ts";

describe("préférences d'une conversation CLI", () => {
  it.each(["fr", "en"] as const)("en %s : ton initial, changement et suppression sans répétition", (lang) => {
    const c = new CliConversation();
    expect(c.prepare({ text: "un", tone: "joueur" }, lang)).toContain('"joueur"');
    expect(c.prepare({ text: "deux", tone: " joueur " }, lang)).toBe("deux");
    expect(c.prepare({ text: "trois", tone: "calme" }, lang)).toContain('"calme"');
    expect(c.prepare({ text: "quatre", tone: "" }, lang)).toContain(lang === "fr" ? "ancien ton annulé" : "previous tone cleared");
    expect(c.prepare({ text: "cinq" }, lang)).toBe("cinq");
  });
  it("rejoue le secours seulement à l'ouverture, tout en gardant le contexte explicite du tour", () => {
    const c = new CliConversation();
    const history = [{ role: "user" as const, text: "ancien échange" }];
    expect(c.prepare({ text: "un", history }, "fr")).toContain("ancien échange");
    expect(c.prepare({ text: "deux", history }, "fr")).toBe("deux");
    const text = c.prepare({ text: "trois", history, context: [{ role: "assistant", text: "contexte utile" }] }, "fr");
    expect(text).toContain("contexte utile");
    expect(text).not.toContain("ancien échange");
  });
});
