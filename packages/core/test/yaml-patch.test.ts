// Retouche ciblée d'un YAML : seuls les nœuds visés changent, tout le reste du texte reste octet pour octet.
import { describe, expect, it } from "vitest";
import { patchYaml, yamlPluginEntries, YamlUnreadable } from "../src/index.ts";

describe("patchYaml", () => {
  it("renomme une clé à un chemin précis : commentaires, lignes vides, ordre, guillemets, flux et ancres intacts", () => {
    const text = `# haut
a:
  vieux: 1   # note

  "vieux2": 2
  autre: { vieux: 3 }
b:
  vieux: 4
c: &x
  vieux: 5
d: *x
`;
    const r = patchYaml(text, [{ path: ["a"], from: "vieux", to: "neuf" }, { path: ["a"], from: "vieux2", to: "neuf2" }, { path: ["c"], from: "vieux", to: "neuf" }]);
    expect(r!.text).toBe(text.replace("  vieux: 1", "  neuf: 1").replace('"vieux2"', '"neuf2"').replace("  vieux: 5", "  neuf: 5"));
    expect(r!.keys.sort()).toEqual(["a.vieux", "a.vieux2", "c.vieux"]);
    expect(r!.conflicts).toEqual([]);
  });

  it("« * » : tous les enfants d'une table ou tous les éléments d'une liste ; une table partagée par alias n'est retouchée qu'une fois", () => {
    const text = "m:\n  p: &b\n    k: 1\n  q: *b\n  r:\n    k: 2\nl:\n  - k: 3\n  - { k: 4 }\n";
    const r = patchYaml(text, [{ path: ["m", "*"], from: "k", to: "key" }, { path: ["l", "*"], from: "k", to: "key" }]);
    expect(r!.text).toBe(text.replace(/\bk:/g, "key:"));
    expect(r!.keys.sort()).toEqual(["l.*.k", "m.*.k"]);
  });

  it("élément de liste choisi par une clé : les autres éléments ne sont pas touchés", () => {
    const text = "plugins:\n  - id: a\n    plugin: voulu\n    config: { vieux: 1 }\n  - id: b\n    plugin: autre\n    config: { vieux: 2 }\n";
    const r = patchYaml(text, [{ path: ["plugins", { key: "plugin", equals: "voulu" }, "config"], from: "vieux", to: "neuf" }]);
    expect(r!.text).toBe(text.replace("{ vieux: 1 }", "{ neuf: 1 }"));
    expect(r!.keys).toEqual(["plugins[plugin=voulu].config.vieux"]);
  });

  it("valeurs : plain, entre apostrophes, entre guillemets ; une autre valeur ou un bloc n'est pas touché", () => {
    const text = "a:\n  m: ancien\n  n: 'ancien'\n  o: \"ancien\"\n  p: autre\n  q: |\n    ancien\n  r: ancien # suite\n";
    const r = patchYaml(text, [{ path: ["a"], key: "m", map: { ancien: "nouveau" } }, { path: ["a"], key: "n", map: { ancien: "nouveau" } }, { path: ["a"], key: "o", map: { ancien: "nouveau" } },
      { path: ["a"], key: "p", map: { ancien: "nouveau" } }, { path: ["a"], key: "q", map: { ancien: "nouveau" } }, { path: ["a"], key: "r", map: { ancien: "nouveau" } }]);
    expect(r!.text).toBe("a:\n  m: nouveau\n  n: 'nouveau'\n  o: \"nouveau\"\n  p: autre\n  q: |\n    ancien\n  r: nouveau # suite\n");
  });

  it("ancien et nouveau nom ensemble : rien n'est écrasé, le chemin du conflit est rendu", () => {
    const text = "a:\n  vieux: 1\n  neuf: 2\n";
    expect(patchYaml(text, [{ path: ["a"], from: "vieux", to: "neuf" }])).toEqual({ text, keys: [], conflicts: ["a.vieux"] });
  });

  it("rien à changer : undefined ; chemin absent, clé absente, scalaire à la place d'une table : rien", () => {
    expect(patchYaml("a:\n  b: 1\nc: 3\n", [{ path: ["x"], from: "b", to: "z" }, { path: ["a"], from: "q", to: "z" }, { path: ["c"], from: "b", to: "z" }, { path: ["a", "b"], from: "b", to: "z" }])).toBeUndefined();
    expect(patchYaml("", [{ path: ["a"], from: "b", to: "z" }])).toBeUndefined();
  });

  it("YAML illisible : lève YamlUnreadable", () => {
    expect(() => patchYaml("a: [oups\n", [{ path: ["a"], from: "b", to: "z" }])).toThrow(YamlUnreadable);
  });
});

describe("yamlPluginEntries", () => {
  it("rend l'id et le plugin de chaque entrée ; le reste est ignoré ; YAML illisible : liste vide", () => {
    expect(yamlPluginEntries("plugins:\n  - { id: a, plugin: x }\n  - id: b\n    plugin: y\n  - { id: c }\n  - 3\n")).toEqual([{ id: "a", plugin: "x" }, { id: "b", plugin: "y" }]);
    expect(yamlPluginEntries("a: 1\n")).toEqual([]);
    expect(yamlPluginEntries("plugins: [oups\n")).toEqual([]);
  });
});
