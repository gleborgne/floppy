// Fenêtre de l'avatar : sans cadre, transparente, toujours devant, en bas à droite ; sa place, sa visibilité,
// le masquage automatique et l'apparition à la demande ; l'affichage (réglages du plugin body-electron reçus du noyau).
// Propriétaire de la fenêtre, de son état de chargement, de l'état du corps (idle, écoute…) et des minuteurs de masquage.
import { app, BrowserWindow, Menu, screen } from "electron";
import { foregroundRect } from "./typer.ts";
import { pageFile, preloadFile } from "./ui.ts";
import { avatarSpot } from "./placement.ts";
import type { Area, Bilingual } from "./placement.ts";
import type { Display } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { VoiceControls } from "./voice-controls.ts";
import type { AppWindows } from "./app-windows.ts";
import type { createDesktopContributions } from "./desktop-contributions.ts";

const W = 320;
const H = 560;     // taille fixe : la bulle a toute la place au-dessus de la tête (les zones vides laissent passer les clics)
const FREE_LISTEN_MS = 10000;

export interface AvatarDeps {
  texts: Texts;
  quitting(): boolean;
  /** Journal du noyau (kernel.log). */
  kernelLog: { write(chunk: string | Buffer): void };
  refreshTray(): void;
  contributions: Pick<ReturnType<typeof createDesktopContributions>, "menu">;
  kernel(): Pick<KernelProcess, "connectBody" | "request">;
  voice(): Pick<VoiceControls, "applyShortcuts">;
  windows(): Pick<AppWindows, "settingsWin" | "onbWin">;
}

export interface AvatarWindow {
  win(): BrowserWindow | null;
  winReady(): boolean;
  /** État du corps (idle, listening, thinking, speaking, sleep…), tel que la page de l'avatar le dit. */
  state(): string;
  display(): Display;
  setState(s: string): void;
  setApprovalOpen(open: boolean): void;
  createWindow(): void;
  placeHome(): void;
  placeAvatar(opts?: { corner?: string; screen?: number; target?: string }): Bilingual;
  showWin(): void;
  hideWin(): void;
  activity(): void;
  settleIdle(): void;
  applyDisplay(s: unknown): void;
  toggleWindow(): void;
  openAvatarMenu(): void;
  /** Déplacement de la fenêtre à la main (phase « start », « move » ou « end »). */
  dragWindow(phase: unknown): void;
  /** À la fermeture : plus de masquage automatique. */
  stopTimers(): void;
}

export function createAvatar(deps: AvatarDeps): AvatarWindow {
  const { texts, kernelLog } = deps;
  const { textError } = texts;
  const lang = () => texts.lang();
  const refreshTray = () => deps.refreshTray();
  const quitting = () => deps.quitting();
  let win: BrowserWindow | null = null;
  let winReady = false;
  let state = "idle";
  // Affichage (réglages du plugin body-electron, reçus du noyau).
  let display: Display = { avatar_visible: true, hide_after: 0, bubble: true, always_on_top: true, avatar: "", avatarUrl: "" };
  let idleTimer: NodeJS.Timeout | undefined;           // masquage automatique après inactivité
  let tempTimer: NodeJS.Timeout | undefined;           // retour au masquage après une apparition temporaire
  let tempShown = false;          // fenêtre montrée alors que avatar_visible est faux
  let cursorTimer: NodeJS.Timeout | undefined;         // position de la souris envoyée à l'avatar (ses yeux la suivent)
  let drag: { cx: number; cy: number; wx: number; wy: number } | null = null;                // déplacement de la fenêtre à la main : { cx, cy, wx, wy } au début
  let approvalOpen = false;

  // ------------------------------------------------------------------ fenêtre de l'avatar
  /** Place de départ de l'avatar : en bas à droite de l'écran principal. */
  function homePosition() {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - W - 12, y: wa.y + wa.height - H - 8 };
  }
  function placeHome() {
    if (!win || win.isDestroyed()) return;
    const { x, y } = homePosition();
    win.setBounds({ x, y, width: W, height: H });
  }
  /** Après un déplacement : l'avatar doit rester dans l'écran le plus proche (sinon il est perdu). */
  function keepOnScreen() {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width);
    const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
    if (x !== b.x || y !== b.y || b.width !== W || b.height !== H) win.setBounds({ x, y, width: W, height: H });
  }

  /** Écrans dans l'ordre que l'utilisateur dit : 1 = principal, puis de gauche à droite. */
  function displaysInOrder() {
    const primary = screen.getPrimaryDisplay();
    return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id).sort((a, b) => a.bounds.x - b.bounds.x)];
  }
  /**
   * Placer l'avatar (outil vocal « place_avatar »). corner : bottom_right, bottom_left, top_right, top_left, center.
   * screen : numéro (1 = principal). target "window" : dans le coin de la fenêtre active (le terminal, le navigateur…).
   */
  function placeAvatar(opts: { corner?: string; screen?: number; target?: string } = {}): Bilingual {
    if (!win || win.isDestroyed()) throw textError({ fr: "l'avatar n'a pas de fenêtre", en: "the avatar has no window" });
    let active: Area | null = null;
    if (opts.target === "window") {
      const r = process.platform === "win32" ? foregroundRect() : null;
      const dip = r && r.width > 0 && r.height > 0 ? screen.screenToDipRect(null, r) : null;
      if (dip) {
        const wa = screen.getDisplayMatching(dip).workArea;
        // La partie visible de la fenêtre (une fenêtre agrandie déborde un peu de l'écran).
        const x = Math.max(dip.x, wa.x), y = Math.max(dip.y, wa.y);
        active = { x, y, width: Math.min(dip.x + dip.width, wa.x + wa.width) - x, height: Math.min(dip.y + dip.height, wa.y + wa.height) - y };
      }
    }
    let spot;
    try { spot = avatarSpot(opts, { screens: displaysInOrder().map((d) => d.workArea), active, W, H }); }
    catch (e) { throw e instanceof Error ? e : textError(e as Bilingual); }
    win.setBounds({ x: spot.x, y: spot.y, width: W, height: H });
    keepOnScreen();
    showWin();
    return spot.text;
  }

  function createWindow() {
    const home = homePosition();
    win = new BrowserWindow({
      width: W, height: H, x: home.x, y: home.y,
      frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      show: false, backgroundColor: "#00000000",
      webPreferences: { preload: preloadFile("preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "floating");
    win.loadFile(pageFile("index"));
    win.once("ready-to-show", () => { if (display.avatar_visible) win?.showInactive(); });
    win.setIgnoreMouseEvents(true, { forward: true }); // clics traversants, sauf sur la tête et la bulle (voir "interactive")
    // Vérification : FLOPPY_SNAPSHOT=<fichier.png> capture la fenêtre de l'avatar toutes les 3 s.
    const snapshot = process.env.FLOPPY_SNAPSHOT;
    if (snapshot) setInterval(async () => {
      // À la fermeture, la fenêtre peut déjà être détruite : on ne capture plus rien.
      if (quitting() || !win || win.isDestroyed()) return;
      const fs = await import("node:fs");
      const img = await win.webContents.capturePage().catch(() => null);
      if (!img) return;
      fs.writeFileSync(snapshot, img.toPNG());
      // Et la fenêtre des réglages si elle est ouverte : <fichier>-reglages.png
      const settingsWin = deps.windows().settingsWin();
      if (settingsWin && !settingsWin.isDestroyed()) {
        // FLOPPY_SETTINGS_SCROLL=<px> : fait défiler la rubrique avant l'image (vérifier le bas d'une page).
        if (process.env.FLOPPY_SETTINGS_SCROLL) await settingsWin.webContents.executeJavaScript(`for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = ${Number(process.env.FLOPPY_SETTINGS_SCROLL) || 0}`).catch(() => {});
        // FLOPPY_SETTINGS_JS=<code> : action avant l'image (ex. cliquer « Ajouter » pour vérifier un formulaire).
        if (process.env.FLOPPY_SETTINGS_JS) await settingsWin.webContents.executeJavaScript(process.env.FLOPPY_SETTINGS_JS).catch(() => {});
        const s = await settingsWin.webContents.capturePage();
        fs.writeFileSync(snapshot.replace(/\.png$/i, "-reglages.png"), s.toPNG());
      }
      // Et la fenêtre « Bienvenue » : <fichier>-bienvenue.png (FLOPPY_ONBOARDING_JS=<code> : action avant l'image).
      const onbWin = deps.windows().onbWin();
      if (onbWin && !onbWin.isDestroyed()) {
        if (process.env.FLOPPY_ONBOARDING_JS) await onbWin.webContents.executeJavaScript(process.env.FLOPPY_ONBOARDING_JS).catch(() => {});
        const o = await onbWin.webContents.capturePage().catch(() => null);
        if (o) fs.writeFileSync(snapshot.replace(/\.png$/i, "-bienvenue.png"), o.toPNG());
      }
    }, 3000);
    // Messages de la page de l'avatar → console et journal (état du micro, erreurs).
    win.webContents.on("console-message", (e) => { const line = `[avatar] ${e.message}\n`; process.stdout.write(line); kernelLog.write(line); });
    win.webContents.on("did-start-loading", () => { winReady = false; });
    win.webContents.on("did-finish-load", () => { winReady = true; deps.kernel().connectBody(); win?.webContents.send("display", { ...display, lang: lang() }); });
    win.on("close", (e) => { if (!quitting()) { e.preventDefault(); win?.hide(); refreshTray(); } });
    win.on("closed", () => { win = null; winReady = false; clearTimeout(idleTimer); clearTimeout(tempTimer); });
    // Comme les autres fenêtres : jamais de navigation ni de nouvelle fenêtre depuis l'avatar.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("context-menu", openAvatarMenu);
    // Les yeux de l'avatar suivent la souris, même hors de sa fenêtre : position relative à la fenêtre, si elle a bougé.
    let lastCursor = "";
    cursorTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible() || !winReady) return;
      const pt = screen.getCursorScreenPoint();
      const b = win.getContentBounds();
      const key = `${pt.x - b.x},${pt.y - b.y}`;
      if (key === lastCursor) return;
      lastCursor = key;
      win.webContents.send("cursor", { x: pt.x - b.x, y: pt.y - b.y });
    }, 50);
    win.on("closed", () => { clearInterval(cursorTimer); cursorTimer = undefined; });
  }

  // ------------------------------------------------------------------ affichage : visible, masquage auto, apparition à la demande
  function hideWin() { if (!quitting() && win && !win.isDestroyed() && win.isVisible()) win.hide(); refreshTray(); }
  function showWin() { if (!quitting() && win && !win.isDestroyed() && !win.isVisible()) win.showInactive(); refreshTray(); }

  function armIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (quitting() || !win || win.isDestroyed() || !display.hide_after || !display.avatar_visible || !win.isVisible()) return;
    idleTimer = setTimeout(() => { if (state === "idle" && !approvalOpen) hideWin(); else armIdleTimer(); }, display.hide_after * 60000);
  }

  /** Toute activité (état actif, carte d'accord, raccourci, clic sur l'icône) : montre la fenêtre si besoin et relance le minuteur. */
  function activity() {
    if (quitting() || !win || win.isDestroyed()) return;
    clearTimeout(tempTimer);
    if (win && !win.isVisible()) {
      if (!display.avatar_visible) tempShown = true;
      showWin();
    }
    armIdleTimer();
  }

  /** Retour au calme : une apparition temporaire se referme après la période d'écoute libre. */
  function settleIdle() {
    armIdleTimer();
    if (!tempShown) return;
    clearTimeout(tempTimer);
    tempTimer = setTimeout(() => {
      if (state === "idle" && !approvalOpen && !display.avatar_visible) { tempShown = false; hideWin(); }
    }, FREE_LISTEN_MS);
  }

  /**
   * Démarrage avec Windows (clé « Exécuter » de l'utilisateur, par Electron). En dev, l'exécutable est electron.exe :
   * on lui passe le dossier de l'app. Le noyau garde le réglage ; ici on l'applique seulement s'il change.
   */
  function applyLoginItem(on: boolean): void {
    const opts = { name: "Floppy", ...(app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }) };
    // `openAtLogin` reste à false avec un nom et des arguments : le vrai état est `executableWillLaunchAtLogin`.
    if (app.getLoginItemSettings(opts).executableWillLaunchAtLogin === on) return;
    app.setLoginItemSettings({ ...opts, openAtLogin: on, enabled: on });
    kernelLog.write(`[app] démarrage avec Windows : ${on ? "activé" : "désactivé"}\n`);
  }

  function applyDisplay(s: unknown): void {
    if (quitting() || !s || typeof s !== "object") return;
    display = { ...display, ...(s as Partial<Display>) };
    if (typeof display.autostart === "boolean") applyLoginItem(display.autostart);
    if (display.shortcuts && typeof display.shortcuts === "object") deps.voice().applyShortcuts(display.shortcuts);
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(!!display.always_on_top, "floating");
    win.webContents.send("display", { ...display, lang: lang() });
    if (display.avatar_visible) { tempShown = false; clearTimeout(tempTimer); showWin(); }
    else if (!tempShown) hideWin();
    armIdleTimer();
  }

  /** Ctrl+Alt+H / icône : passe par le noyau pour que le réglage `avatar_visible` reste juste (et gardé). */
  function toggleWindow() {
    if (quitting() || !win || win.isDestroyed()) return;
    const show = !win.isVisible();
    tempShown = false;
    clearTimeout(tempTimer);
    applyDisplay({ avatar_visible: show });
    deps.kernel().request({ type: "settings.set", key: "avatar_visible", value: show });
  }

  function openAvatarMenu() {
    const items = deps.contributions.menu("avatar");
    if (items.length && win) Menu.buildFromTemplate(items).popup({ window: win });
  }

  /** Déplacer l'avatar à la main (la tête n'est plus une zone « drag » : un clic sans bouger la chatouille). */
  function dragWindow(phase: unknown) {
    if (!win) return;
    const pt = screen.getCursorScreenPoint();
    if (phase === "start") { const [wx, wy] = win.getPosition() as [number, number]; drag = { cx: pt.x, cy: pt.y, wx, wy }; }
    else if (phase === "move" && drag) win.setPosition(Math.round(drag.wx + pt.x - drag.cx), Math.round(drag.wy + pt.y - drag.cy));
    else if (phase === "end") { drag = null; keepOnScreen(); }
  }

  return {
    win: () => win, winReady: () => winReady, state: () => state, display: () => display,
    setState: (s) => { state = s; }, setApprovalOpen: (open) => { approvalOpen = open; },
    createWindow, placeHome, placeAvatar, showWin, hideWin, activity, settleIdle, applyDisplay, toggleWindow, openAvatarMenu,
    dragWindow, stopTimers: () => { clearTimeout(idleTimer); clearTimeout(tempTimer); },
  };
}
