import { describe, it, expect } from "vitest";
// @ts-expect-error module .js sans types
import { listAdd, missingFields, chainOf } from "../src/renderer/form-rules.js";

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
