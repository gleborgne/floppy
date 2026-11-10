import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src/prompt.ts";

const base = { name: "Floppy", today: new Date("2026-11-05"), mode: "voice" as const, emotions: false };

describe("buildPrompt : ton", () => {
  it("inclut la ligne de ton", () => {
    const s = buildPrompt({ ...base, tone: "sobre et factuel" });
    expect(s).toContain("Ton : sobre et factuel. Le ton change seulement tes mots, jamais ce que tu fais (outils, accords).");
  });
  it("sans ton, pas de ligne", () => {
    expect(buildPrompt(base)).not.toContain("Ton :");
  });
});

import { claimState } from "../src/index.ts";
describe("garde-fou contre les fausses actions", () => {
  it("reconnaît les débuts de « c'est fait » / « j'ai ouvert »", () => {
    expect(claimState("C'est fait.")).toBe("claim");
    expect(claimState("C'es")).toBe("maybe");
    expect(claimState("J’ai ouvert la fenêtre")).toBe("claim");
    expect(claimState("Tu as deux PR")).toBe("no");
    expect(claimState("J'ai deux PR pour toi")).toBe("no");
  });
});

describe("buildPrompt : outils visibles", () => {
  const tools = [{ name: "change_setting" }, { name: "agenda_du_jour" }];
  it("ne cite que les outils visibles", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "delegate" });
    expect(s).toContain("Tes outils : change_setting, agenda_du_jour.");
    expect(s).toContain("change_setting tout de suite");
  });
  it("un outil désactivé n'est jamais mentionné (ni connecteur codé en dur)", () => {
    const s = buildPrompt({ ...base, tools: [{ name: "agenda_du_jour" }], delegateTool: "delegate" });
    for (const w of ["change_setting", "open_settings", "open_url", "ouvrir_url", "orca_agents", "etat_build", "envoyer_mail", "Azure DevOps", "Obsidian", "Orca"]) expect(s).not.toContain(w);
    expect(buildPrompt({ ...base, tools: [] })).toContain("aucun outil");
  });
  it("la règle des documents n'apparaît que si show_document est visible", () => {
    expect(buildPrompt({ ...base, tools: [{ name: "show_document" }] })).toContain("appelle show_document");
    expect(buildPrompt({ ...base, tools: [{ name: "agenda_du_jour" }] })).not.toContain("show_document");
  });
  it("garde les trois chemins demander / déléguer / faire", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "delegate" });
    expect(s).toMatch(/1\. DEMANDER[\s\S]*2\. DÉLÉGUER[\s\S]*3\. FAIRE/);
    expect(s).toContain("appelle delegate tout de suite");
  });
});

import { claimState as claim } from "../src/index.ts";
import { promptLang, readPhrases, waitPhrases, READ_PHRASES, WAIT_PHRASES, WAIT_PHRASES_EN } from "../src/prompt.ts";
describe("buildPrompt : langue de l'assistant", () => {
  const tools = [{ name: "change_setting" }, { name: "show_document" }];
  it("français par défaut (sans langue ou langue inconnue), inchangé", () => {
    const fr = buildPrompt({ ...base, tools, delegateTool: "delegate" });
    expect(buildPrompt({ ...base, tools, delegateTool: "delegate", lang: "fr" })).toBe(fr);
    expect(buildPrompt({ ...base, tools, delegateTool: "delegate", lang: "de" })).toBe(fr);
    expect(fr).toContain("Réponds en français");
  });
  it("anglais : mêmes chemins, mêmes outils, réponses en anglais", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "delegate", lang: "en", emotions: true, tone: "dry and factual" });
    expect(s).toContain("You are Floppy");
    expect(s).toContain("Answer in English");
    expect(s).toMatch(/1\. ASK[\s\S]*2\. DELEGATE[\s\S]*3\. DO/);
    expect(s).toContain("call delegate right away");
    expect(s).toContain("Your tools: change_setting, show_document.");
    expect(s).toContain("call show_document");
    expect(s).toContain("Tone: dry and factual.");
    expect(s).toContain("[happy]");
    expect(s).not.toMatch(/Réponds|Tes outils|\[content\]/);
  });
  it("anglais sans délégation ni outil", () => {
    const s = buildPrompt({ ...base, lang: "en", tools: [] });
    expect(s).toContain("You have no tools");
    expect(s).toMatch(/1\. ASK[\s\S]*2\. DO/);
    expect(s).not.toContain("DELEGATE");
  });
  it("phrases d'attente et de lecture selon la langue", () => {
    expect(promptLang("en")).toBe("en");
    expect(promptLang(undefined)).toBe("fr");
    expect(waitPhrases("fr")).toBe(WAIT_PHRASES);
    expect(waitPhrases("en")).toBe(WAIT_PHRASES_EN);
    expect(readPhrases("fr")).toBe(READ_PHRASES);
    expect(readPhrases("en").every((p) => /^[\x20-\x7e]+$/.test(p))).toBe(true);
  });
  it("garde-fou des fausses actions en anglais", () => {
    expect(claim("Done.", "en")).toBe("claim");
    expect(claim("Sure! I've opened the window", "en")).toBe("claim");
    expect(claim("I", "en")).toBe("maybe");
    expect(claim("You have two PRs", "en")).toBe("no");
    expect(claim("Done.")).toBe("no"); // français par défaut
  });
});

import { timeLine } from "../src/prompt.ts";
describe("buildPrompt : cache de préfixe", () => {
  const today = new Date(2026, 10, 5, 14, 32);
  it("la date du jour reste, l'heure n'est plus dans le prompt système", () => {
    const fr = buildPrompt({ ...base, today });
    expect(fr).toContain("(2026-11-05).");
    expect(fr).not.toContain("14:32");
    expect(buildPrompt({ ...base, today, lang: "en" })).not.toContain("14:32");
    expect(buildPrompt({ ...base, today: new Date(2026, 10, 5, 9, 1) })).toBe(fr); // même prompt à toute heure du jour
  });
  it("la ligne d'heure est dans la langue de l'assistant", () => {
    expect(timeLine(today, "fr")).toBe("(Il est 14:32.)");
    expect(timeLine(today, "en")).toBe("(It is 14:32.)");
  });
  it("la mémoire (qui change) vient après toutes les parties stables", () => {
    const s = buildPrompt({ ...base, today, tone: "sobre", emotions: true, delegateTool: "delegate", memory: { user: "U", memory: "M" } });
    const at = (t: string) => s.indexOf(t);
    expect(at("Ton : sobre")).toBeGreaterThan(at("3. FAIRE"));
    expect(at("Ce que tu sais")).toBeGreaterThan(at("Ton : sobre"));
    expect(at("Ce que tu sais")).toBeGreaterThan(at("[content]"));
    expect(s.endsWith("[Tes notes]\nM")).toBe(true);
  });
});
