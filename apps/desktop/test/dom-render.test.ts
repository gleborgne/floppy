import { describe, it, expect } from "vitest";
// @ts-expect-error module .js sans types
import { fingerprint, sameContent, replaceIfChanged } from "../src/renderer/dom.js";

// Faux nœuds DOM : juste ce que lit l'empreinte (pas de navigateur dans les tests).
type N = { nodeType: number; tagName?: string; data?: string; attributes?: { name: string; value: string }[]; childNodes?: N[]; value?: string; checked?: boolean };
const text = (data: string): N => ({ nodeType: 3, data });
const el = (tagName: string, attrs: Record<string, string> = {}, kids: N[] = [], extra: Partial<N> = {}): N =>
  ({ nodeType: 1, tagName: tagName.toUpperCase(), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), childNodes: kids, ...extra });
const parent = (kids: N[]) => ({ childNodes: kids, replaced: 0, replaceChildren(...n: N[]) { this.childNodes = n; this.replaced++; } });

describe("rendu sans clignotement", () => {
  it("une page identique n'est pas reconstruite (ids de nextId ignorés)", () => {
    const a = [el("label", { for: "f3" }, [text("Nom")]), el("input", { id: "f3", "aria-describedby": "f4" }, [], { value: "x" })];
    const b = [el("label", { for: "f9" }, [text("Nom")]), el("input", { id: "f9", "aria-describedby": "f10" }, [], { value: "x" })];
    const p = parent(a);
    expect(replaceIfChanged(p, b)).toBe(false);
    expect(p.replaced).toBe(0);
    expect(p.childNodes).toBe(a);
  });
  it("un texte, un attribut, la valeur d'un champ ou une case qui change : reconstruite", () => {
    const base = () => [el("div", { class: "srow" }, [text("connecté")]), el("input", { type: "checkbox" }, [], { checked: true, value: "" })];
    for (const change of [
      [el("div", { class: "srow" }, [text("en panne")]), base()[1]],
      [el("div", { class: "srow here" }, [text("connecté")]), base()[1]],
      [base()[0], el("input", { type: "checkbox" }, [], { checked: false, value: "" })],
      [base()[0]],
    ]) {
      const p = parent(base());
      expect(replaceIfChanged(p, change)).toBe(true);
      expect(p.replaced).toBe(1);
    }
  });
  it("l'ordre des attributs ne compte pas ; un vrai id (pas f12) compte", () => {
    expect(fingerprint(el("a", { x: "1", y: "2" }))).toBe(fingerprint(el("a", { y: "2", x: "1" })));
    expect(sameContent(parent([el("h2", { id: "editor-title" })]), [el("h2", { id: "autre" })])).toBe(false);
  });
});
