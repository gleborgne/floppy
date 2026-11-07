// Dossier des fenêtres compilées (npm run build:ui) : pages, scripts et preloads que charge Electron.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** apps/desktop/build : sortie de scripts/build-ui.mjs (hors du dépôt git). */
export const UI_DIR = join(here, "..", "build");

/** Page d'une fenêtre : build/renderer/<nom>.html. */
export function pageFile(name: string, dir = UI_DIR): string {
  return join(dir, "renderer", `${name}.html`);
}

/** Preload d'une fenêtre : build/<nom>.cjs. */
export function preloadFile(name: string, dir = UI_DIR): string {
  return join(dir, name);
}

/** Message à montrer quand les fenêtres n'ont pas été compilées, ou null si tout est là. */
export function missingUi(dir = UI_DIR): string | null {
  return existsSync(pageFile("index", dir)) && existsSync(preloadFile("preload.cjs", dir))
    ? null
    : `Les fenêtres de Floppy ne sont pas compilées (${dir} est absent ou incomplet). Lancez « npm run build:ui » (ou « npm start », qui le fait) puis relancez l'application.`;
}
