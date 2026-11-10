import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Interface minimale d'un dessin d'avatar (voir docs/spec/corps-et-avatar.md). */
export interface DrawnAvatar {
  setState(s: string): void; setEmotion(name: string, intensity?: number, ms?: number): void; setLevel(v: number): void;
  setMood?(valence: number, energy: number): void; setHearing?(v: number): void; lookAt?(x: number, y: number): void;
  cue?(name: string): void; setMouth?(open: number, wide: number): void; destroy(): void;
}

/** Source d'un dessin prête à évaluer : `export` retiré, et les `import { … } from "./x.js"` d'un voisin du même dossier
 *  remplacés par le texte de ce voisin (même portée : le test n'a pas besoin d'un chargeur de modules). */
export function avatarSource(id: string): string {
  const dir = new URL(`../../../plugins/avatar/${id}/renderer/`, import.meta.url);
  const strip = (s: string) => s.replace(/export (?=function|const)/g, "");
  const index = readFileSync(new URL("index.js", dir), "utf8");
  const siblings: string[] = [];
  const body = index.replace(/^import\s*\{[^}]*\}\s*from\s*"\.\/([\w-]+\.js)";?[ \t]*$/gm, (_all, file: string) => {
    siblings.push(strip(readFileSync(new URL(file, dir), "utf8")));
    return "";
  });
  return [...siblings, strip(body)].join("\n");
}

/** Exécute le vrai dessin ; capture les uniformes transmis au GPU, sans dépendre d'un pilote graphique. */
export function boot(id: string, opts: { reducedMotion?: boolean; motion?: unknown; random?: () => number }) {
  const source = avatarSource(id);
  const names = [...source.matchAll(/uniform\s+\w+\s+([^;]+);/g)].flatMap(m => m[1]!.split(",").map(v => v.trim().replace(/\[.*$/, "")));
  const values: Record<string, number[]> = {};
  const state = { clock: 0, next: (_now: number) => {} };
  const gl = new Proxy({}, { get(_target, key) {
    if (key === "getProgramParameter") return (_p: unknown, flag: string) => flag === "ACTIVE_UNIFORMS" ? names.length : true;
    if (key === "getShaderParameter") return () => true;
    if (key === "getActiveUniform") return (_p: unknown, i: number) => ({ name: names[i] });
    if (key === "getUniformLocation") return (_p: unknown, name: string) => name;
    if (String(key).startsWith("uniform")) return (name: string, ...args: unknown[]) => { values[name] = args.flatMap(v => typeof v === "number" ? [v] : Array.from(v as number[])); };
    if (/^[A-Z_0-9]+$/.test(String(key))) return key;
    if (String(key).startsWith("create")) return () => ({});
    return () => {};
  } });
  const canvas = { style: {}, width: 240, height: 240, getContext: () => gl, getBoundingClientRect: () => ({ width: 240, height: 240 }), remove() {} };
  const env = { document: { createElement: () => canvas }, window: { devicePixelRatio: 1 }, performance: { now: () => state.clock },
    Math: Object.assign(Object.create(Math), { random: opts.random ?? (() => 0.5) }),
    requestAnimationFrame: (fn: (now: number) => void) => { state.next = fn; return 1; }, cancelAnimationFrame() {},
    create: undefined as unknown as (box: object, o: object) => DrawnAvatar };
  runInNewContext(source + "\nglobalThis.create = create;", env);
  const avatar = env.create({ append() {} }, { reducedMotion: opts.reducedMotion ?? false, motion: opts.motion });
  return { avatar, values, state };
}
