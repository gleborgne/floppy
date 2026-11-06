// Kit de développement des plugins utilisateur : copié dans <home>/plugins, sans jamais écraser un fichier existant.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kit");

/** Copie les fichiers du kit qui n'existent pas encore. Rend les chemins (relatifs) copiés. */
export function copyKit(dest: string, src = KIT_DIR): string[] {
  const copied: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const from = join(dir, name);
      if (statSync(from).isDirectory()) { walk(from); continue; }
      const to = join(dest, relative(src, from));
      if (existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(relative(src, from));
    }
  };
  mkdirSync(dest, { recursive: true });
  walk(src);
  return copied;
}
