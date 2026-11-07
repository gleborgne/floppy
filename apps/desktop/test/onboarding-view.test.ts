import { describe, it, expect } from "vitest";
import { gb, needsManual, stepsFor, machineRows, levelFacts, rowStatus, defaultLevel, installSummary, tr } from "../src/renderer/onboarding-view.ts";

const GIB = 1024 ** 3;
const t = (k: string) => `<${k}>`;

describe("fenêtre Bienvenue", () => {
  it("tailles en Go, arrondies à 0,5, dans les deux langues", () => {
    expect(gb(9.4 * GIB, "fr")).toBe("9,5 Go");
    expect(gb(9.4 * GIB, "en")).toBe("9.5 GB");
    expect(gb(16 * GIB, "fr")).toBe("16 Go");
  });

  it("choix à la main seulement si rien n'a été lu", () => {
    expect(needsManual({ machine: { sources: [] } })).toBe(true);
    expect(needsManual({ machine: { sources: ["sysctl"] } })).toBe(false);
  });

  it("étape du cerveau cloud seulement pour un niveau qui en a besoin", () => {
    expect(stepsFor({ brain: "cloud" })).toEqual(["machine", "level", "brain", "install"]);
    expect(stepsFor({ brain: "local" })).toEqual(["machine", "level", "install"]);
  });

  it("résumé de la machine : puce, mémoire, RAM, disque", () => {
    const m = { gpu: { name: "Apple M4" }, memory: "unified", modelBytes: 8 * GIB, ramBytes: 16 * GIB, diskFreeBytes: 100 * GIB };
    expect(machineRows(m, t, "fr")).toEqual([["<chip>", "Apple M4"], ["<memoryKind>", "<unified>"], ["<forModels>", "8 Go"], ["<ram>", "16 Go"], ["<disk>", "100 Go"]]);
    expect(machineRows({ ramBytes: 8 * GIB }, t, "en")).toEqual([["<chip>", "<noChip>"], ["<ram>", "8 GB"]]);
  });

  it("niveau : modèles et téléchargement, ou la raison", () => {
    const picks = [{ label: { fr: "Parakeet", en: "Parakeet" } }, { label: "Gemma" }];
    expect(levelFacts({ picks, possible: true, downloadBytes: 2 * GIB }, t, "fr")).toEqual({ models: "Parakeet · Gemma", note: "<toDownload> 2 Go", warn: false });
    expect(levelFacts({ picks, possible: false, reason: { fr: "il manque 4 Go", en: "missing 4 GB" } }, t, "en")).toEqual({ models: "Parakeet · Gemma", note: "missing 4 GB", warn: true });
  });

  it("état d'une ligne d'installation", () => {
    expect(rowStatus({ state: "downloading", progress: 0.42 }, t, "fr")).toBe("42 %");
    expect(rowStatus({ state: "downloading", progress: 0.42 }, t, "en")).toBe("42%");
    expect(rowStatus({ state: "error", text: { fr: "réseau", en: "network" } }, t, "en")).toBe("network");
    expect(rowStatus({ state: "ready" }, t, "fr")).toBe("<ready>");
  });

  it("niveau choisi au départ : le conseil", () => {
    const plan = { recommended: "voix", levels: [{ id: "texte", possible: true }, { id: "voix", possible: true }] };
    expect(defaultLevel(plan)).toBe("voix");
    expect(tr({ fr: "a", en: "b" }, "en")).toBe("b");
  });
});

describe("installation de départ dans les réglages", () => {
  const rows = [{ state: "ready" }, { state: "downloading", progress: 0.4 }, { state: "waiting" }];
  it("rien à montrer avant une installation", () => {
    expect(installSummary(null)).toBeNull();
    expect(installSummary({ phase: "idle", rows: [], notes: [] })).toBeNull();
  });
  it("en cours, terminée, ou un morceau a échoué : morceaux prêts sur le total", () => {
    expect(installSummary({ phase: "installing", rows, notes: [] })).toEqual({ running: true, ready: 1, total: 3, failed: false });
    expect(installSummary({ phase: "testing", rows, notes: [] })?.running).toBe(true);
    expect(installSummary({ phase: "error", rows, notes: [] })).toMatchObject({ running: false, failed: true });
  });
});
