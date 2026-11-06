import { describe, expect, it } from "vitest";
import { Dictation, type DictationEdit } from "../src/dictation.ts";

/** Rejoue les frappes sur un texte, comme le ferait la zone de saisie. */
function apply(text: string, e: DictationEdit | undefined) { return e ? text.slice(0, text.length - e.del) + e.ins : text; }

describe("dictée : mots confirmés", () => {
  it("ne tape un mot que s'il revient deux fois, et jamais le dernier de l'hypothèse", () => {
    const d = new Dictation();
    expect(d.partial(0, "Il fait")).toBeUndefined();
    expect(d.partial(0, "Il fait beau")).toEqual({ del: 0, ins: "Il fait" });
    expect(d.partial(0, "Il fait beau aujourd'hui")).toEqual({ del: 0, ins: " beau" });
  });

  it("attend quand le moteur change d'avis, puis la version finale complète sans rien effacer", () => {
    const d = new Dictation();
    let t = "";
    t = apply(t, d.partial(0, "Corrige le"));
    t = apply(t, d.partial(0, "Corrige le test"));
    t = apply(t, d.partial(0, "Corrige les tests et"));
    expect(t).toBe("Corrige le"); // « les » contredit « le » : plus rien n'est tapé
    t = apply(t, d.final(0, "Corrige les tests et relance."));
    expect(t).toBe("Corrige les tests et relance.");
  });

  it("corrige un mot tapé qui diffère de la version finale", () => {
    const d = new Dictation();
    let t = "";
    t = apply(t, d.partial(0, "Il fait bon temps"));
    t = apply(t, d.partial(0, "Il fait bon temps ici"));
    expect(t).toBe("Il fait bon temps");
    const e = d.final(0, "Il fait beau temps ici.");
    expect(e?.del).toBe("on temps".length); // « Il fait b » est gardé
    expect(apply(t, e)).toBe("Il fait beau temps ici.");
  });

  it("sépare les segments par une espace et ignore les hypothèses en retard", () => {
    const d = new Dictation();
    let t = "";
    t = apply(t, d.final(0, "Bonjour."));
    expect(d.partial(0, "Bonjour toi")).toBeUndefined();
    t = apply(t, d.partial(1, "Ça va bien"));
    t = apply(t, d.partial(1, "Ça va bien ?"));
    t = apply(t, d.final(1, "Ça va bien ?"));
    expect(t).toBe("Bonjour. Ça va bien ?");
  });

  it("efface un segment qui finit vide, espace comprise", () => {
    const d = new Dictation();
    let t = apply("", d.final(0, "Un."));
    t = apply(t, d.partial(1, "euh euh euh"));
    t = apply(t, d.partial(1, "euh euh euh"));
    expect(t).toBe("Un. euh euh");
    t = apply(t, d.final(1, ""));
    expect(t).toBe("Un.");
  });
});
