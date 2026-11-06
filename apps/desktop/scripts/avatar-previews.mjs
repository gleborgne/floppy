// Fabrique l'aperçu fixe de chaque avatar (plugins/avatar/<id>/renderer/preview.png), montré dans Réglages → Corps.
//   npx electron apps/desktop/scripts/avatar-previews.mjs [id …]      (depuis la racine du dépôt)
// À relancer quand on ajoute un avatar ou qu'on change son dessin.
import { app, BrowserWindow } from "electron";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const avatarsDir = resolve(here, "../../../plugins/avatar");
const wanted = process.argv.slice(2).filter((a) => !a.endsWith(".mjs") && a !== ".");
const ids = readdirSync(avatarsDir).filter((id) => existsSync(join(avatarsDir, id, "renderer", "index.js")) && (!wanted.length || wanted.includes(id)));
const SIZE = 240;

// Une fenêtre fermée par avatar : ne pas quitter quand la dernière se ferme, on quitte à la fin.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const page = pathToFileURL(join(here, "avatar-preview.html")).href;
  for (const id of ids) {
    const src = pathToFileURL(join(avatarsDir, id, "renderer", "index.js")).href;
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      // Une fenêtre neuve par avatar : chaque dessin a son propre contexte WebGL.
      const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, paintWhenInitiallyHidden: true, useContentSize: true, backgroundColor: "#0a0e14", webPreferences: { backgroundThrottling: false } });
      try {
        await win.loadURL(`${page}?src=${encodeURIComponent(src)}`);
        await new Promise((r) => setTimeout(r, 2200)); // l'avatar s'installe (ressorts, respiration)
        const error = await win.webContents.executeJavaScript("window.__error ?? ''");
        if (error) throw new Error(error);
        const img = await win.webContents.capturePage();
        const out = join(avatarsDir, id, "renderer", "preview.png");
        writeFileSync(out, img.resize({ width: 168, height: 168, quality: "best" }).toPNG());
        console.log(`${id} : ${out}`);
        done = true;
      } catch (e) {
        console.log(`${id} : essai ${attempt} raté (${e?.message ?? e})`);
      } finally {
        win.destroy();
      }
    }
  }
  app.quit();
});
