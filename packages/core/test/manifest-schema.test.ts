// Le manifeste est refusé s'il a un champ inconnu (faute de frappe) à n'importe quel niveau.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, manifestError, manifestProblem } from "../src/index.ts";

const base = { id: "p", version: "0.1.0", licence: "MIT" };

describe("manifeste : champs inconnus refusés", () => {
  it("un manifeste complet et correct passe (tous les niveaux)", () => {
    expect(manifestError({
      ...base, description: { fr: "d", en: "d" }, provides: ["task", "llm"], inject: ["a"], optional: ["b"], lazy: true, startTimeout_s: 30,
      slots: [{ id: "a.b", service: "llm", section: "s", label: "L", description: "D", none: "N", defaultFirst: true, display: "tabs", step: 1 }],
      tasks: [{ id: "t", label: "T", description: "D", schedule: { at: "07:30", days: [1, 2] }, timeout_s: 60, configure: "veille" }],
      permissions: { "fs.read": ["~/x"], "fs.write": ["~/y"], net: ["a.com"], exec: ["git"], cloud: true, approvals: "respond" },
      sections: [{ id: "s", label: "S", description: "D", order: 3, icon: "mic", parent: "p", merge: true, view: "v" }],
      addable: {
        section: "s", label: "A", description: "D", cloud: true, single: true, aliases: ["a"], program: "codex", logo: { program: "codex" },
        fields: [{
          key: "k", label: "K", type: "select", options: [{ value: "v", label: "V" }], placeholder: "p", hint: "h", required: true, default: 1, advanced: true,
          showIf: { key: "x", values: ["a"] }, filters: [{ name: "n", extensions: ["gguf"] }], directory: false, min: 0, max: 5, prompts: ["p"], textKey: "t", seconds: { min: 1, max: 2 },
        }],
      },
    })).toBeUndefined();
  });

  it("champ inconnu au premier niveau : nommé, avec la suggestion du champ proche", () => {
    expect(manifestError({ ...base, optionnal: ["memory"] })).toBe("optionnal : champ inconnu (voulais-tu « optional » ?)");
    expect(manifestError({ ...base, injects: ["memory"] })).toBe("injects : champ inconnu (voulais-tu « inject » ?)");
    expect(manifestError({ ...base, banane: 1 })).toBe("banane : champ inconnu");
  });

  it("le message est dans les deux langues (et l'entrée l'affiche)", () => {
    expect(manifestProblem({ ...base, optionnal: [] })).toEqual({
      fr: "optionnal : champ inconnu (voulais-tu « optional » ?)",
      en: "optionnal : unknown field (did you mean \"optional\"?)",
    });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "man-")), plugins: [definePlugin({ manifest: { ...base, optionnal: ["memory"] } as never, apply() {} })] });
    return k.applyConfig({ plugins: [{ id: "e", plugin: "p", config: {} }] }).then(() => {
      const st = k.status().find((s) => s.id === "e")!;
      expect(st.state).toBe("error");
      expect(st.error).toBe("manifeste invalide : optionnal : champ inconnu (voulais-tu « optional » ?)");
      return k.settings.change("langue_interface", "en", "ui").then(() => {
        expect(k.status().find((s) => s.id === "e")!.error).toBe("invalid manifest: optionnal : unknown field (did you mean \"optional\"?)");
      });
    });
  });

  it("champ inconnu dans slots[], permissions, addable, sections[], tasks[] et un champ de formulaire", () => {
    expect(manifestError({ ...base, slots: [{ id: "a", service: "llm", section: "s", label: "L", defualtFirst: true }] })).toBe("slots.0.defualtFirst : champ inconnu (voulais-tu « defaultFirst » ?)");
    expect(manifestError({ ...base, permissions: { network: ["a.com"] } })).toBe("permissions.network : champ inconnu");
    expect(manifestError({ ...base, permissions: { nett: ["a.com"] } })).toBe("permissions.nett : champ inconnu (voulais-tu « net » ?)");
    expect(manifestError({ ...base, addable: { section: "s", label: "A", singel: true } })).toBe("addable.singel : champ inconnu (voulais-tu « single » ?)");
    expect(manifestError({ ...base, addable: { section: "s", label: "A", fields: [{ key: "k", label: "K", type: "text", placehoder: "x" }] } })).toBe("addable.fields.0.placehoder : champ inconnu (voulais-tu « placeholder » ?)");
    expect(manifestError({ ...base, sections: [{ id: "s", label: "S", ordre: 1 }] })).toBe("sections.0.ordre : champ inconnu (voulais-tu « order » ?)");
    expect(manifestError({ ...base, provides: ["task"], tasks: [{ id: "t", label: "T", timeout: 5 }] })).toBe("tasks.0.timeout : champ inconnu (voulais-tu « timeout_s » ?)");
    // Champs retirés (sélecteur de fournisseur `serviceSelection`, étiquette `runtime`) : refusés comme tout champ inconnu.
    expect(manifestError({ ...base, runtime: "in-process" })).toBe("runtime : champ inconnu");
    expect(manifestError({ ...base, provides: ["llm"], serviceSelection: { service: "llm", section: "s", label: "L", none: "N" } })).toBe("serviceSelection : champ inconnu");
  });

  it("champ inconnu dans une union (schedule, logo) : le problème est nommé", () => {
    expect(manifestError({ ...base, provides: ["task"], tasks: [{ id: "t", label: "T", schedule: { every: "3h", jour: 1 } }] })).toMatch(/^tasks.0.schedule.jour : champ inconnu/);
    expect(manifestError({ ...base, addable: { section: "s", label: "A", logo: { programme: "x" } } })).toMatch(/addable\.logo/);
  });

  it("plusieurs problèmes sont tous donnés ; les autres règles restent actives", () => {
    const r = manifestError({ ...base, optionnal: [], lazzy: true })!;
    expect(r).toContain("optionnal : champ inconnu");
    expect(r).toContain("lazzy : champ inconnu (voulais-tu « lazy » ?)");
    expect(manifestError({ ...base, provides: ["x"], tasks: [{ id: "a", label: "A" }] })).toMatch(/task/);
    expect(manifestError({ ...base, id: "Mauvais" })).toMatch(/^id : /);
  });
});
