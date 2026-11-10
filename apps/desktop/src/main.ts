// Processus principal de l'app : une seule app = le noyau (utilityProcess) + le corps par défaut (avatar).
// Point d'entrée : il pose les réglages de départ, crée un module par métier et les relie ; la logique est dans eux.
// - kernel-process.ts : lance le noyau, le surveille, le relance s'il s'arrête (et son journal, ses demandes, le port du corps).
// - kernel-messages.ts : ce que le noyau envoie (réglages, éléments, premier lancement, état des plugins).
// - avatar.ts : fenêtre de l'avatar (sans cadre, transparente, toujours devant), sa place, son masquage automatique.
// - tray.ts : icône dans la barre des tâches (couleur = état) et son menu.
// - voice-controls.ts / dictation.ts : parler, dormir, dictée, raccourcis globaux.
// - app-windows.ts : réglages, « Bienvenue », résultats, documents. chat-window.ts : la fenêtre « Conversation ». ipc.ts : les canaux des pages.
// Relie l'avatar au noyau par un MessagePort (même protocole que le WebSocket des autres corps).
import { app, globalShortcut, session, dialog } from "electron";
import type { WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { missingUi } from "./ui.ts";
import { safeWindow } from "./windows.ts";
import { createDesktopContributions } from "./desktop-contributions.ts";
import { createTexts } from "./app-texts.ts";
import { createTray } from "./tray.ts";
import { createKernelProcess } from "./kernel-process.ts";
import { createKernelMessages } from "./kernel-messages.ts";
import { createAvatar } from "./avatar.ts";
import { createAppWindows } from "./app-windows.ts";
import { createChatWindow } from "./chat-window.ts";
import { createVoiceControls } from "./voice-controls.ts";
import { createDictation } from "./dictation.ts";
import { registerIpc } from "./ipc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");                     // dossier assistant/
// Config imposée (FLOPPY_CONFIG) ; sinon le noyau lit <répertoire de travail>/floppy.yml (apps/cli/src/boot.ts).
const CONFIG = process.env.FLOPPY_CONFIG ? resolve(process.env.FLOPPY_CONFIG) : null;
// Mode debug d'un plugin : `npm start -- --dev-plugin <dossier>` (répétable). Le noyau le charge activé et le relit
// à chaque sauvegarde (apps/cli/src/boot.ts, variable FLOPPY_DEV_PLUGINS ; le noyau hérite de l'environnement).
const DEV_PLUGINS = (process.argv ?? []).flatMap((a, i, all) => a === "--dev-plugin" && all[i + 1] ? [resolve(all[i + 1]!)] : a.startsWith("--dev-plugin=") ? [resolve(a.slice(13))] : []);
if (DEV_PLUGINS.length) process.env.FLOPPY_DEV_PLUGINS = DEV_PLUGINS.join(delimiter);

let quitting = false;

// Vérification à côté d'un Floppy déjà lancé : FLOPPY_USER_DATA=<dossier> donne une autre instance (verrou à part).
if (process.env.FLOPPY_USER_DATA) app.setPath("userData", process.env.FLOPPY_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
// Micro et voix sans clic préalable (sinon Chromium crée les AudioContext en pause : avatar sourd et muet).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
process.chdir(ROOT); // les chemins relatifs de floppy.yml partent de la racine du dépôt

// ------------------------------------------------------------------ les modules, reliés
// Chaque module reçoit ce qu'il utilise des autres sous forme de fonctions lues à l'appel : ils sont créés dans cet ordre,
// mais se parlent dans les deux sens (la barre des tâches se rafraîchit pour tous, et lit l'état de tous).
const texts = createTexts();
const contributions = createDesktopContributions({ create: safeWindow, lang: () => texts.lang(),
  local: [
    { id: "settings", title: { fr: "Réglages", en: "Settings" }, menus: ["tray"], order: 10, open: () => { windows.openSettings(); } },
    { id: "chat", title: { fr: "Ouvrir la conversation", en: "Open the conversation" }, menus: ["avatar"], order: 10, open: () => { chat.open(); } },
  ],
  send: (message) => kernelProcess.kernel()?.postMessage(message), changed: () => tray.refresh(),
  log: (id, reason) => console.log(`[desktop] ${id}: ${reason}`),
});
const tray = createTray({
  texts, quitting: () => quitting, menu: (location) => contributions.menu(location),
  kernel: () => kernelProcess, avatar: () => avatar, voice: () => voice, dictation: () => dictation, windows: () => windows, chat: () => chat,
});
const kernelProcess = createKernelProcess({
  root: ROOT, config: CONFIG, entry: join(here, "kernel.ts"), texts, quitting: () => quitting,
  problems: tray.problems, refreshTray: () => tray.refresh(),
  onMessage: (m, source) => messages.handle(m, source), clearContributions: () => contributions.clear(),
  avatar: () => avatar,
});
const messages = createKernelMessages({
  texts, problems: tray.problems, contributions, kernel: () => kernelProcess, avatar: () => avatar, windows: () => windows,
  refreshTray: () => tray.refresh(),
});
const avatar = createAvatar({
  texts, quitting: () => quitting, kernelLog: kernelProcess.log, refreshTray: () => tray.refresh(), contributions,
  kernel: () => kernelProcess, voice: () => voice, windows: () => windows,
});
const windows = createAppWindows({
  texts, contributions, refreshTray: () => tray.refresh(),
  kernel: () => kernelProcess, avatar: () => avatar, dictation: () => dictation, chat: () => chat,
});
const chat = createChatWindow({
  texts, refreshTray: () => tray.refresh(), kernel: () => kernelProcess, avatar: () => avatar, voice: () => voice,
});
const voice = createVoiceControls({
  texts, kernelLog: kernelProcess.log, problems: tray.problems, refreshTray: () => tray.refresh(),
  avatar: () => avatar, dictation: () => dictation, chat: () => chat,
});
const dictation = createDictation({
  texts, kernelLog: kernelProcess.log, problems: tray.problems, refreshTray: () => tray.refresh(), avatar: () => avatar,
});

// ------------------------------------------------------------------ démarrage
app.whenReady().then(() => {
  // Fenêtres non compilées (npm run build:ui) : message clair plutôt que des fenêtres blanches.
  const missing = missingUi();
  if (missing) { console.error(missing); dialog.showErrorBox("Floppy", missing); app.quit(); return; }
  // Micro : seulement pour nos fenêtres (fichiers locaux) : l'avatar, les réglages (enregistrer une voix) et « Bienvenue »
  // (l'essai du micro). Rien d'autre.
  const micOk = (wc: WebContents | null | undefined) => {
    const settingsWin = windows.settingsWin();
    const onbWin = windows.onbWin();
    return !!wc && (wc === avatar.win()?.webContents
      || (!!settingsWin && !settingsWin.isDestroyed() && wc === settingsWin.webContents)
      || (!!onbWin && !onbWin.isDestroyed() && wc === onbWin.webContents));
  };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === "media" && micOk(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === "media" && micOk(wc));
  tray.create();
  avatar.createWindow();
  kernelProcess.start();
  if (process.env.FLOPPY_SETTINGS_PAGE) setTimeout(windows.openSettings, 3000);
  // Raccourcis globaux. Un raccourci déjà pris par une autre app (ex. Claude desktop prend Ctrl+Alt+Espace) est signalé.
  voice.applyShortcuts(avatar.display().shortcuts ?? texts.shortcuts);
  registerIpc({
    texts, contributions, refreshTray: () => tray.refresh(),
    kernel: () => kernelProcess, messages: () => messages, avatar: () => avatar, voice: () => voice, dictation: () => dictation, windows: () => windows, chat: () => chat,
  });
});

app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  avatar.stopTimers();
  globalShortcut.unregisterAll();
  const source = kernelProcess.kernel();
  if (!source) return;
  e.preventDefault();
  let finished = false;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timeout); app.quit(); };
  const timeout = setTimeout(() => { source.kill(); finish(); }, 5000);
  source.once("exit", finish);
  try { source.postMessage({ type: "stop" }); } catch { finish(); }
});
app.on("window-all-closed", () => { /* l'app reste dans la barre des tâches */ });
// Une fenêtre dont le rendu plante (avatar, réglages…) est rechargée ; au-delà de 3 pannes en 5 minutes, on la laisse.
let rendererCrashes: number[] = [];
app.on("render-process-gone", (_e, contents, details) => {
  if (quitting || details?.reason === "clean-exit") return;
  const now = Date.now();
  rendererCrashes = [...rendererCrashes.filter((t) => now - t < 300000), now];
  kernelProcess.log.write(`\n[app] une fenêtre s'est arrêtée (${details?.reason}, code ${details?.exitCode})${rendererCrashes.length > 3 ? " : trop de pannes, pas de rechargement" : " : rechargement"}\n`);
  if (rendererCrashes.length > 3) return;
  setTimeout(() => { if (!contents.isDestroyed()) contents.reload(); }, 1000);
});
