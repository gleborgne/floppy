// Chromium réel : happy-dom ne calcule ni les hauteurs flex ni le défilement.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [renderer, scratch, capture] = process.argv.slice(2);
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(2), 20000);
app.whenReady().then(async () => {
  const css = ["settings.css", "settings-v2.css"].map(f => readFileSync(join(renderer, f), "utf8")).join("\n");
  const row = n => `<div class="srow lrow"><div class="rt"><div class="rn"><strong>Modèle ${n}</strong></div><div class="rd">Une voix française avec ses variantes disponibles.</div><div class="tags"><span class="chip tag">français</span><span class="chip tag">Q8</span></div></div><div class="lside"><button class="btn small">Télécharger</button></div></div>`;
  const section = (label, count) => `<h3 class="shead">${label}</h3><div class="scard">${Array.from({ length: count }, (_, n) => row(n)).join("")}</div>`;
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style><dialog id="editor" class="library"><div class="ed-head chead"><h2>Modèles à télécharger</h2><button class="btn small">×</button></div><div class="lsearch"><input class="lsinput" placeholder="Filtrer les modèles"></div><div class="lbody">${section("Catalogue en ligne", 2)}${section("audio.cpp", 2)}${section("Modèles de voix", 25)}</div><p class="lfoot">Télécharger un modèle, c'est accepter sa licence.</p></dialog><script>document.querySelector('dialog').showModal()</script>`;
  const file = join(scratch, "library.html"); writeFileSync(file, html);
  const results = [];
  const win = new BrowserWindow({ width: 1000, height: 1000, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  for (const [width, height] of [[1000, 1000], [520, 800]]) {
    win.setContentSize(width, height);
    const result = await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.lbody');
      const clipped = [...body.querySelectorAll('.scard')].filter(c => c.scrollHeight > c.clientHeight + 1).length;
      body.scrollTop = body.scrollHeight;
      const last = body.querySelector('.scard:last-child .lrow:last-child').getBoundingClientRect();
      const viewport = body.getBoundingClientRect();
      return { clipped, scrollTop: body.scrollTop, scrollable: body.scrollHeight > body.clientHeight + 1,
        lastVisible: last.bottom <= viewport.bottom + 1 && last.top >= viewport.top };
    })()`);
    results.push({ width, height, ...result });
    if (capture && !capture.startsWith("--") && width === 1000) writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
  }
  console.log("LAYOUT_RESULT=" + JSON.stringify(results));
  win.destroy();
  clearTimeout(deadline); app.quit();
}).catch(err => { console.error(err); app.exit(1); });
