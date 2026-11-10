// Vérification Chromium de la vraie bulle, sans noyau ni modèles.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [source, scratch, capture] = process.argv.slice(2);
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(2), 20000);
app.whenReady().then(async () => {
  const css = readFileSync(join(source, "style.css"), "utf8");
  const page = readFileSync(join(source, "index.html"), "utf8");
  const main = page.slice(page.indexOf("<main"), page.indexOf("</main>") + 7);
  const win = new BrowserWindow({ width: 480, height: 560, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<html><style>${css}</style><body>${main}</body></html>`));
  const results = [];
  for (const width of [480, 400]) {
    win.setContentSize(width, 560);
    const result = await win.webContents.executeJavaScript(`(() => {
      const bubble = document.querySelector('#bubble');
      const cards = document.querySelector('#cards');
      bubble.classList.remove('hide');
      const report = "L'agent a terminé de restructurer les notes et de vérifier les liens entre les documents du projet. Les dossiers ont été réorganisés et les doublons regroupés pour faciliter la recherche des informations utiles. Il attend votre validation de cette nouvelle organisation avant de publier les changements dans les documents partagés avec toute l'équipe.";
      cards.innerHTML = '<div class="card info"><h3>Important</h3><p></p></div>';
      const text = cards.querySelector('p'); text.textContent = report;
      const normalClipped = cards.scrollHeight > cards.clientHeight + 1;
      document.querySelector('#listen').hidden = false;
      const listeningClipped = cards.scrollHeight > cards.clientHeight + 1;
      const bubbleTop = bubble.getBoundingClientRect().top;
      text.textContent = report.repeat(8);
      const longScrollable = cards.scrollHeight > cards.clientHeight + 1;
      cards.scrollTop = cards.scrollHeight;
      const lastVisible = text.getBoundingClientRect().bottom <= cards.getBoundingClientRect().bottom + 1;
      text.textContent = report; cards.scrollTop = 0;
      return { normalClipped, listeningClipped, bubbleTop, longScrollable, lastVisible };
    })()`);
    results.push({ width, ...result });
    if (capture && width === 480) {
      await new Promise(resolve => setTimeout(resolve, 250));
      writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
    }
  }
  console.log("LAYOUT_RESULT=" + JSON.stringify(results));
  win.destroy(); clearTimeout(deadline); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
