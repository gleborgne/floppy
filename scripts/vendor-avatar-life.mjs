// Copie le « vivant » commun des avatars (scripts/avatar/life.js, l'unique source) à côté du dessin de chaque avatar
// qui l'utilise : renderer/life.js, octet pour octet. Un plugin ne dépend pas d'un autre et son dessin doit marcher
// seul (galerie des réglages, ancienne version de l'app) : chaque avatar garde donc sa copie.
//   npm run vendor:avatars
// Le test apps/desktop/test/avatar-life.test.ts vérifie que les copies suivent la source.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "avatar", "life.js");
/** Les avatars qui importent ./life.js. */
export const AVATARS = ["goutte", "iris", "oscillo", "pixelcat"];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const id of AVATARS) copyFileSync(SOURCE, join(dirname(SOURCE), "..", "..", "plugins", "avatar", id, "renderer", "life.js"));
  console.log(`life.js copié dans ${AVATARS.length} avatars : ${AVATARS.join(", ")}`);
}
