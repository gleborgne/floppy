// Copie Preact (node_modules) dans la fenêtre : elle charge ses scripts du disque, sans outil d'assemblage, et la
// politique de sécurité n'autorise que ses propres fichiers. Relancer après une mise à jour de preact :
//   npm run vendor -w @floppy/desktop
// Le test vendor.test.ts vérifie que la copie suit la version installée.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(createRequire(import.meta.url).resolve("preact/package.json"));
const out = join(here, "..", "src", "renderer", "vendor");
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "dist", "preact.mjs"), join(out, "preact.mjs"));
copyFileSync(join(root, "dist", "preact.mjs.map"), join(out, "preact.mjs.map"));
copyFileSync(join(root, "LICENSE"), join(out, "preact.LICENSE"));
console.log("preact copié dans", out);
