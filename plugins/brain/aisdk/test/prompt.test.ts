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
  const tools = [{ name: "changer_reglage" }, { name: "agenda_du_jour" }];
  it("ne cite que les outils visibles", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "deleguer" });
    expect(s).toContain("Tes outils : changer_reglage, agenda_du_jour.");
    expect(s).toContain("changer_reglage tout de suite");
  });
  it("un outil désactivé n'est jamais mentionné (ni connecteur codé en dur)", () => {
    const s = buildPrompt({ ...base, tools: [{ name: "agenda_du_jour" }], delegateTool: "deleguer" });
    for (const w of ["changer_reglage", "ouvrir_reglages", "ouvrir_url", "orca_agents", "etat_build", "envoyer_mail", "Azure DevOps", "Obsidian", "Orca"]) expect(s).not.toContain(w);
    expect(buildPrompt({ ...base, tools: [] })).toContain("aucun outil");
  });
  it("la règle des documents n'apparaît que si afficher_document est visible", () => {
    expect(buildPrompt({ ...base, tools: [{ name: "afficher_document" }] })).toContain("appelle afficher_document");
    expect(buildPrompt({ ...base, tools: [{ name: "agenda_du_jour" }] })).not.toContain("afficher_document");
  });
  it("garde les trois chemins demander / déléguer / faire", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "deleguer" });
    expect(s).toMatch(/1\. DEMANDER[\s\S]*2\. DÉLÉGUER[\s\S]*3\. FAIRE/);
    expect(s).toContain("appelle deleguer tout de suite");
  });
});

import { claimState as claim } from "../src/index.ts";
import { promptLang, readPhrases, waitPhrases, READ_PHRASES, WAIT_PHRASES, WAIT_PHRASES_EN } from "../src/prompt.ts";
describe("buildPrompt : langue de l'assistant", () => {
  const tools = [{ name: "changer_reglage" }, { name: "afficher_document" }];
  it("français par défaut (sans langue ou langue inconnue), inchangé", () => {
    const fr = buildPrompt({ ...base, tools, delegateTool: "deleguer" });
    expect(buildPrompt({ ...base, tools, delegateTool: "deleguer", lang: "fr" })).toBe(fr);
    expect(buildPrompt({ ...base, tools, delegateTool: "deleguer", lang: "de" })).toBe(fr);
    expect(fr).toContain("Réponds en français");
  });
  it("anglais : mêmes chemins, mêmes outils, réponses en anglais", () => {
    const s = buildPrompt({ ...base, tools, delegateTool: "deleguer", lang: "en", emotions: true, tone: "dry and factual" });
    expect(s).toContain("You are Floppy");
    expect(s).toContain("Answer in English");
    expect(s).toMatch(/1\. ASK[\s\S]*2\. DELEGATE[\s\S]*3\. DO/);
    expect(s).toContain("call deleguer right away");
    expect(s).toContain("Your tools: changer_reglage, afficher_document.");
    expect(s).toContain("call afficher_document");
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
