// Kit de développement des plugins utilisateur : copié dans <home>/plugins, sans jamais écraser un fichier existant.
// Il réunit le dossier kit/ de ce plugin (règles pour l'agent, exemple) et les types du SDK (@floppy/sdk).
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");
/** Types des plugins, source unique : le SDK. */
export const SDK_TYPES = fileURLToPath(import.meta.resolve("@floppy/sdk/floppy-plugin.d.ts"));

/** Copie les fichiers du kit qui n'existent pas encore. Rend les chemins (relatifs) copiés. */
export function copyKit(dest: string, src = KIT_DIR, types: string | undefined = SDK_TYPES): string[] {
  const copied: string[] = [];
  const copy = (from: string, rel: string): void => {
    const to = join(dest, rel);
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(rel);
  };
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name);
      if (statSync(from).isDirectory()) { walk(from); continue; }
      copy(from, relative(src, from));
    }
  };
  mkdirSync(dest, { recursive: true });
  walk(src);
  if (types) copy(types, "floppy-plugin.d.ts");
  return copied;
}
