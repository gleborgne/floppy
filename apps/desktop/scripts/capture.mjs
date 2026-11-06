// Capture une page du renderer en PNG (galerie des émotions pour la doc).
//   npx electron apps/desktop/scripts/capture.mjs <page.html[#hash]> <sortie.png> [largeur] [hauteur]
import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [page, out, w = "1110", h = "760"] = process.argv.slice(2).filter((a) => !a.endsWith("capture.mjs") && a !== ".");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: +w, height: +h, show: false, paintWhenInitiallyHidden: true, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const [file, hash] = page.split("#");
  win.webContents.on("console-message", (e) => console.log("[page]", e.message));
  await win.loadFile(resolve(file), hash ? { hash } : {});
  await new Promise((r) => setTimeout(r, 1800));
  const img = await win.webContents.capturePage();
  writeFileSync(resolve(out), img.toPNG());
  console.log("écrit", out);
  app.quit();
});
