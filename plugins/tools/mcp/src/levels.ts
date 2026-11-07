// Niveau d'un outil MCP : config > annotations MCP > inconnu = write.
// « readOnlyHint » abaisse le niveau (plus d'accord) : il ne compte que d'un serveur auquel on fait confiance.
// « destructiveHint » ne peut que durcir : il compte toujours.
import type { Level, Rule } from "@floppy/core";

export type LevelSetting = Level | "never";

export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

/** Le motif exact gagne sur les motifs avec joker ; parmi les jokers, le plus long gagne. */
export function levelFromConfig(name: string, levels: Record<string, LevelSetting>): LevelSetting | undefined {
  if (levels[name]) return levels[name];
  const hits = Object.keys(levels).filter((p) => p.includes("*") || p.includes("?")).filter((p) => globToRegExp(p).test(name));
  hits.sort((a, b) => b.length - a.length);
  return hits[0] ? levels[hits[0]] : undefined;
}

export function resolveLevel(name: string, levels: Record<string, LevelSetting>, ann?: Annotations, trustReadOnly = true): { level: Level; rule?: Rule } {
  const fromCfg = levelFromConfig(name, levels);
  if (fromCfg === "never") return { level: "write", rule: "never" };
  if (fromCfg) return { level: fromCfg };
  if (ann?.readOnlyHint === true && trustReadOnly && ann.destructiveHint !== true) return { level: "read" };
  if (ann?.destructiveHint === true) return { level: "delete" };
  return { level: "write" }; // outil inconnu = traité comme une écriture
}

/** Vrai si le nom correspond à l'un des motifs (nom exact ou joker `*` / `?`). */
export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => p === name || ((p.includes("*") || p.includes("?")) && globToRegExp(p).test(name)));
}
