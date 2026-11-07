import { describe, it, expect } from "vitest";
import { splitLibraries, librariesFor, downloadSummary, libraryShape, percent } from "../src/renderer/library.ts";

const lib = (id: string, source: string, offers: string | string[], items: object[] = [], can = { search: false }) => ({ id, source, offers, layout: "library", can, items });

describe("bibliothèques de modèles (fenêtre des réglages)", () => {
  it("sépare les bibliothèques des autres fournisseurs", () => {
    const a = lib("sherpa-lib", "stt-sherpa", ["vad", "stt"]);
    const b = { id: "sherpa", layout: "list", offers: ["vad", "stt"], items: [] };
    expect(splitLibraries([a, b])).toEqual({ libraries: [a], others: [b] });
  });

  it("trouve les bibliothèques d'un rôle, et d'un plugin précis", () => {
    const a = lib("sherpa-lib", "stt-sherpa", ["vad", "stt"]);
    const c = lib("tts-lib", "tts-audiocpp", "tts");
    expect(librariesFor([a, c], "stt")).toEqual([a]);
    expect(librariesFor([a, c], "tts", "tts-audiocpp")).toEqual([c]);
    expect(librariesFor([a, c], "tts", "tts-system")).toEqual([]);
  });

  it("résume les téléchargements en cours", () => {
    const a = lib("l", "s", "stt", [{ id: "x", status: "loading", progress: 0.2 }, { id: "y", status: "loading", progress: 0.6 }, { id: "z", status: "ok" }]);
    expect(downloadSummary([a])).toEqual({ count: 2, progress: 0.4 });
    expect(downloadSummary([lib("l", "s", "stt", [{ id: "z" }])])).toEqual({ count: 0, progress: null });
    expect(downloadSummary([lib("l", "s", "stt", [{ id: "x", status: "loading" }])])).toEqual({ count: 1, progress: null });
  });

  it("garde la même forme quand seul l'avancement bouge (pas de rendu complet)", () => {
    const before = lib("l", "s", "stt", [{ id: "x", status: "loading", progress: 0.1, statusText: "10 %", actions: [{ id: "cancel" }] }]);
    const after = lib("l", "s", "stt", [{ id: "x", status: "loading", progress: 0.5, statusText: "50 %", actions: [{ id: "cancel" }] }]);
    const done = lib("l", "s", "stt", [{ id: "x", status: "ok", actions: [{ id: "remove" }] }]);
    expect(libraryShape([before])).toBe(libraryShape([after]));
    expect(libraryShape([before])).not.toBe(libraryShape([done]));
  });

  it("arrondit le pourcentage vers le bas, entre 0 et 100", () => {
    expect(percent(0.429)).toBe(42);
    expect(percent(undefined)).toBe(0);
    expect(percent(1.5)).toBe(100);
  });
});
