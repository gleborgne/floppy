// Chromium isolé : le vrai renderer compilé, un pont simulé, aucun noyau ni commande d'agent.
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [built, scratch, capture] = process.argv.slice(2);
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(2), 20000);
app.whenReady().then(async () => {
  const now = Date.now();
  const row = (id, label, project, extra = {}) => ({ id, label, project, activity: "working", presence: "live", outcome: "unknown", observedAt: now, lastSeenAt: now, ...extra });
  const data = { lang: "fr", snapshot: { at: now, connection: { state: "connected", coverage: "partial", lastSyncAt: now }, agents: [
    row("a", "Camille · Recherche", "Contoso", { progress: "Validation des filtres et du clavier", mission: "Rendre la recherche plus rapide", details: "Le filtre par projet est prêt. Vérification des derniers cas limites." }),
    row("b", "Robin · Interface", "Contoso", { activity: "waiting", waitingReason: "Choisir le libellé de la nouvelle navigation" }),
    row("c", "Alex · Tests", "Fabrikam", { activity: "finished", outcome: "success", declaredResult: "Les tests ciblés passent." }),
    row("d", "Sam · Documentation", "Fabrikam", { observedAt: now - 180000, presence: "unknown", lastAction: "Relecture du guide" }),
  ], events: [{ eventId: "e1", agentId: "a", at: now, kind: "progress", summary: "Tests de sélection ajoutés" }] } };
  const preload = join(scratch, "tracking-preload.cjs");
  writeFileSync(preload, `const {contextBridge}=require('electron');const data=${JSON.stringify(data)};contextBridge.exposeInMainWorld('floppyDesktop',{get:async()=>data,action:async()=>({ok:true}),onUpdate:()=>()=>{}});`);
  const win = new BrowserWindow({ width: 760, height: 700, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (e) => { if (e.level === "error") errors.push(e.message); });
  await win.loadFile(join(built, "renderer", "tracking.html"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const results = [];
  for (const [width, height] of [[760, 700], [400, 700]]) {
    win.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 80));
    results.push(await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.agent-row')];
      const selected = rows.find(r => r.textContent.includes('Camille'));
      if (selected.getAttribute('aria-expanded') !== 'true') selected.click();
      const detail = document.querySelector('#agent-detail');
      const list = document.querySelector('.agent-list');
      detail.scrollTop = detail.scrollHeight;
      return { width: innerWidth, count: rows.length, horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        hasMission: detail.textContent.includes('Rendre la recherche'), boundedList: list.clientHeight < innerHeight,
        detailReachable: detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 1 };
    })()`));
    if (capture && width === 760) {
      await win.webContents.executeJavaScript("document.querySelector('#agent-detail').scrollTop=0");
      await win.webContents.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
    }
  }
  console.log("TRACKING_LAYOUT=" + JSON.stringify({ results, errors }));
  win.destroy(); clearTimeout(deadline); app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
