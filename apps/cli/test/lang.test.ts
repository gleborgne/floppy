import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliLang, sayer } from "../src/lang.ts";
import { parseAnswer } from "../src/chat.ts";

describe("langue de la CLI", () => {
  it("lit ui_language dans settings.json, sinon le français", () => {
    const home = mkdtempSync(join(tmpdir(), "floppy-cli-lang-"));
    expect(cliLang(home)).toBe("fr");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ ui_language: "en" }));
    expect(cliLang(home)).toBe("en");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ ui_language: "klingon" }));
    expect(cliLang(home)).toBe("fr");
    writeFileSync(join(home, "settings.json"), "pas du json");
    expect(cliLang(home)).toBe("fr");
  });

  it("sayer choisit la phrase de la langue", () => {
    expect(sayer("en")("Relancé.", "Restarted.")).toBe("Restarted.");
    expect(sayer("fr")("Relancé.", "Restarted.")).toBe("Relancé.");
  });

  it("chat : o/oui/y/yes accordent, n/non/no refusent", () => {
    for (const t of ["o", "Oui", "y", "YES"]) expect(parseAnswer(t)).toBe(true);
    for (const t of ["n", "non", "No"]) expect(parseAnswer(t)).toBe(false);
    expect(parseAnswer("bonjour")).toBeUndefined();
  });
});
