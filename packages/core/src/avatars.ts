// Avatars = plugins de la famille `plugins/avatar/<id>/` :
//   avatar.json      id, nom (fr/en), description (fr/en), émotions dessinées
//   src/index.ts     plugin du noyau : export default defineAvatar(import.meta.url)
//   renderer/        le dessin, chargé par la page de l'avatar : index.js exporte create(container, opts)
// Chaque plugin d'avatar s'inscrit auprès du service `avatars` (fourni par body-electron), qui les montre dans
// Réglages → Corps et affichage et envoie l'adresse du dessin choisi à l'app.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definePlugin, type PluginDef } from "./plugin/manifest.ts";
import type { AvatarEntry, AvatarInfo } from "./services.ts";
import { tr } from "./i18n.ts";

/** Lit avatar.json à la racine du plugin et trouve renderer/index.js. */
export function readAvatarDir(root: string): AvatarEntry {
  const j = JSON.parse(readFileSync(join(root, "avatar.json"), "utf8")) as Partial<AvatarInfo>;
  const id = String(j.id ?? "");
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`avatar.json : id invalide (${id})`);
  const entry = join(root, "renderer", "index.js");
  if (!existsSync(entry)) throw new Error(`avatar ${id} : renderer/index.js manquant`);
  const png = join(root, "renderer", "preview.png");
  return {
    id, name: j.name ?? id, description: j.description ?? "",
    emotions: Array.isArray(j.emotions) ? j.emotions.map(String) : [],
    url: pathToFileURL(entry).href,
    ...(existsSync(png) ? { preview: `data:image/png;base64,${readFileSync(png).toString("base64")}` } : {}),
  };
}

/** Plugin du noyau pour un avatar. À appeler depuis src/index.ts du plugin : defineAvatar(import.meta.url). */
export function defineAvatar(moduleUrl: string): PluginDef<Record<string, never>> {
  const root = join(dirname(fileURLToPath(moduleUrl)), "..");
  const meta = readAvatarDir(root);
  return definePlugin({
    manifest: {
      id: `avatar-${meta.id}`,
      version: "0.1.0",
      licence: "MIT",
      description: { fr: `Avatar « ${tr(meta.name, "fr")} » de l'app de bureau.`, en: `“${tr(meta.name, "en")}” avatar for the desktop app.` },
      // Facultatif : sans l'app (mode --headless), l'avatar ne sert à rien mais ne bloque rien.
      optional: ["avatars"],
    },
    apply(ctx) {
      const reg = ctx.maybe("avatars");
      if (!reg) return;
      ctx.effect(reg.register(readAvatarDir(root)));
    },
  });
}
