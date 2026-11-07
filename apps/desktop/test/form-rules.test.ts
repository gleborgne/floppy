import { describe, it, expect } from "vitest";
// @ts-expect-error module .js sans types
import { listAdd, missingFields, chainOf, addOutcome, goneOption } from "../src/renderer/form-rules.js";

describe("listAdd (pastilles d'un champ liste)", () => {
  it("ajoute un mot tapé, sans espaces autour", () => {
    expect(listAdd(["floppy"], "  flopy ")).toEqual(["floppy", "flopy"]);
  });
  it("un collage de plusieurs lignes ou virgules donne plusieurs pastilles", () => {
    expect(listAdd([], "floppy, flopy\nfloppie;;")).toEqual(["floppy", "flopy", "floppie"]);
  });
  it("pas de doublon, même en changeant les majuscules ; texte vide : rien", () => {
    expect(listAdd(["Floppy"], "floppy")).toEqual(["Floppy"]);
    expect(listAdd(["a"], "   ")).toEqual(["a"]);
    expect(listAdd(undefined, "x")).toEqual(["x"]);
  });
});

describe("missingFields", () => {
  const fields = [{ key: "words", required: true }, { key: "name" }, { key: "path", required: true }];
  it("une liste vide ou un texte blanc manque ; un champ facultatif jamais", () => {
    expect(missingFields(fields, { words: [], path: "  " }).map((f: { key: string }) => f.key)).toEqual(["words", "path"]);
    expect(missingFields(fields, { words: ["a"], path: "C:/models/x" })).toEqual([]);
  });
  it("un champ caché n'est pas demandé", () => {
    expect(missingFields(fields, {}, (f: { key: string }) => f.key !== "path").map((f: { key: string }) => f.key)).toEqual(["words"]);
  });
});

describe("chainOf (étapes d'une rubrique)", () => {
  it("range les slots selon leur place", () => {
    const s = [{ id: "wake", step: 3 }, { id: "vad", step: 1 }, { id: "stt", step: 2 }];
    expect(chainOf(s).map((x: { id: string }) => x.id)).toEqual(["vad", "stt", "wake"]);
  });
  it("un seul slot, ou un slot sans place : pas de chaîne", () => {
    expect(chainOf([{ id: "wake", step: 3 }])).toBeNull();
    expect(chainOf([{ id: "vad", step: 1 }, { id: "stt" }])).toBeNull();
    expect(chainOf([])).toBeNull();
  });
});

describe("addOutcome (après « Ajouter »)", () => {
  it("réussi : la fenêtre se ferme, un toast dit le résultat (pas de 2e fenêtre)", () => {
    expect(addOutcome({ ok: true, text: "« X » ajouté." }, true)).toEqual({ close: true, toast: { text: "« X » ajouté.", bad: false } });
    expect(addOutcome({ ok: true, text: "" }, true, { done: "Fait", refused: "Refusé" }).toast?.text).toBe("Fait");
  });
  it("raté : l'erreur sous le formulaire, la fenêtre reste ouverte", () => {
    expect(addOutcome({ ok: false, text: "Il faut un nom." }, true)).toEqual({ close: false, error: "Il faut un nom." });
  });
  it("fenêtre fermée pendant l'attente : un toast, rouge si raté", () => {
    expect(addOutcome({ ok: false, text: "Non" }, false)).toEqual({ close: false, toast: { text: "Non", bad: true } });
    expect(addOutcome({ ok: true, text: "Oui" }, false)).toEqual({ close: false, toast: { text: "Oui", bad: false } });
  });
});

describe("goneOption (choix gardé qui n'est plus proposé)", () => {
  const options = [{ value: "C:/models/base.gguf", label: "Base" }];
  it("rend le nom court d'une valeur absente de la liste", () => {
    expect(goneOption(options, "C:\\models\\custom.gguf")).toBe("custom.gguf");
  });
  it("rien quand la valeur est proposée ou vide", () => {
    expect(goneOption(options, "C:/models/base.gguf")).toBeUndefined();
    expect(goneOption(options, "")).toBeUndefined();
    expect(goneOption(options, undefined)).toBeUndefined();
  });
});
