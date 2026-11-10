// Retouche ciblée d'un fichier YAML de l'utilisateur (floppy.yml) : renomme des clés et des valeurs scalaires à un
// CHEMIN précis, sans jamais réécrire le document. On lit le YAML pour LOCALISER les nœuds (bibliothèque `yaml`,
// celle du chargeur de la config), puis on remplace dans le texte d'origine seulement les caractères de ces nœuds :
// commentaires, lignes vides, ordre, guillemets, style de flux, ancres et indentation restent octet pour octet.
// Ce qui n'est pas visé (plugins inconnus, clés inconnues) n'est jamais lu comme une cible, donc jamais touché.
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap } from "yaml";

/**
 * Un pas du chemin :
 * - `"cle"` : l'enfant de ce nom d'une table ;
 * - `"*"` : tous les enfants d'une table ou tous les éléments d'une liste ;
 * - `{ key, equals }` : les éléments d'une liste dont la table a `key: equals` (ex. `{ key: "plugin", equals: "veille" }`).
 */
export type YamlStep = string | { key: string; equals: string };

/** Renomme la clé `from` en `to` dans chaque table que désigne `path`. */
export interface YamlRenameKey { path: readonly YamlStep[]; from: string; to: string }
/** Dans chaque table que désigne `path`, change la valeur texte de la clé `key` selon `map` (ancienne → nouvelle). */
export interface YamlMapValue { path: readonly YamlStep[]; key: string; map: Readonly<Record<string, string>> }
export type YamlOp = YamlRenameKey | YamlMapValue;

export interface YamlPatch {
  /** Nouveau texte (identique à l'ancien sauf aux endroits retouchés). */
  text: string;
  /** Chemins retouchés, avec « * » à la place des noms choisis par l'utilisateur : jamais de valeurs. */
  keys: string[];
  /** Chemins où l'ancien et le nouveau nom sont tous deux présents : le nouveau est gardé, l'ancien est laissé. */
  conflicts: string[];
}

/** Le texte n'est pas un YAML lisible. */
export class YamlUnreadable extends Error {}

const label = (path: readonly YamlStep[], leaf: string): string =>
  [...path.map((s) => (typeof s === "string" ? s : `[${s.key}=${s.equals}]`)), leaf].join(".").replace(/\.\[/g, "[");

/** Les tables que désigne le chemin (les alias sont suivis une seule fois : une ancre n'est retouchée qu'à sa définition). */
function targets(doc: Document, root: Node | null, path: readonly YamlStep[]): YAMLMap[] {
  const follow = (n: unknown): unknown => (isAlias(n) ? n.resolve(doc) : n);
  let level: unknown[] = [root];
  for (const step of path) {
    const next: unknown[] = [];
    for (const raw of level) {
      const n = follow(raw);
      if (typeof step === "string" && step !== "*") {
        if (isMap(n)) { const v = n.get(step, true); if (v !== undefined) next.push(v); }
      } else if (step === "*") {
        if (isMap(n)) for (const p of n.items) next.push(p.value);
        else if (isSeq(n)) next.push(...n.items);
      } else if (isSeq(n)) {
        for (const item of n.items) {
          const m = follow(item);
          if (isMap(m) && String(m.get(step.key) ?? "") === step.equals) next.push(m);
        }
      }
    }
    level = next;
  }
  const maps = level.map(follow).filter(isMap);
  return [...new Set(maps)];
}

/** Texte brut d'un scalaire simple ou entre guillemets (sans les guillemets), ou undefined si le nœud n'est pas de cette forme. */
function rawScalar(text: string, node: unknown): { start: number; end: number; quote: string; value: string } | undefined {
  if (!isScalar(node) || !node.range) return undefined;
  const [start, end] = node.range;
  const raw = text.slice(start, end);
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : "";
  const value = quote ? raw.slice(1, -1) : raw;
  if (quote ? raw.length < 2 || raw[raw.length - 1] !== quote : /[\r\n#]/.test(raw)) return undefined;
  if (/[\r\n\\]/.test(value)) return undefined;
  return { start, end, quote, value };
}

/**
 * Applique les opérations. Rend undefined s'il n'y a rien à changer. Lève `YamlUnreadable` si le YAML ne se lit pas.
 * Une cible dont le texte n'est pas un scalaire simple (échappements, bloc) est laissée telle quelle.
 */
export function patchYaml(text: string, ops: readonly YamlOp[]): YamlPatch | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new YamlUnreadable(doc.errors[0]!.message);
  const edits = new Map<number, { start: number; end: number; to: string }>();
  const keys = new Set<string>();
  const conflicts = new Set<string>();
  for (const op of ops) {
    for (const map of targets(doc, doc.contents, op.path)) {
      if ("from" in op) {
        const pair = map.items.find((p) => isScalar(p.key) && p.key.value === op.from);
        if (!pair) continue;
        if (map.items.some((p) => isScalar(p.key) && p.key.value === op.to)) { conflicts.add(label(op.path, op.from)); continue; }
        const raw = rawScalar(text, pair.key);
        if (!raw || raw.value !== op.from) continue;
        edits.set(raw.start, { start: raw.start, end: raw.end, to: raw.quote + op.to + raw.quote });
        keys.add(label(op.path, op.from));
      } else {
        const pair = map.items.find((p) => isScalar(p.key) && p.key.value === op.key);
        const raw = rawScalar(text, pair?.value);
        if (!raw || !Object.hasOwn(op.map, raw.value)) continue;
        edits.set(raw.start, { start: raw.start, end: raw.end, to: raw.quote + op.map[raw.value]! + raw.quote });
        keys.add(label(op.path, op.key));
      }
    }
  }
  if (!edits.size) return conflicts.size ? { text, keys: [], conflicts: [...conflicts] } : undefined;
  let out = text;
  for (const e of [...edits.values()].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.to + out.slice(e.end);
  return { text: out, keys: [...keys], conflicts: [...conflicts] };
}

/** Les entrées `plugins:` d'un floppy.yml (id et type de plugin), en lecture seule ; illisible : liste vide. */
export function yamlPluginEntries(text: string): { id: string; plugin: string }[] {
  const doc = parseDocument(text);
  if (doc.errors.length) return [];
  const plugins = doc.get("plugins", true);
  if (!isSeq(plugins)) return [];
  const out: { id: string; plugin: string }[] = [];
  for (const item of plugins.items) {
    const m = isAlias(item) ? item.resolve(doc) : item;
    if (!isMap(m)) continue;
    const id = m.get("id");
    const plugin = m.get("plugin");
    if (typeof id === "string" && typeof plugin === "string") out.push({ id, plugin });
  }
  return out;
}
