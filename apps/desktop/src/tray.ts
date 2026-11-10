// Icône de la barre des tâches (un rond de couleur = l'état) et son menu. Propriétaire de l'icône et des problèmes montrés.
import { Tray, Menu, nativeImage, shell, app } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { dotPng, COLORS } from "./tray-icon.ts";
import type { Rgb } from "./tray-icon.ts";
import type { TextKey } from "./main-texts.ts";
import type { Say } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { VoiceControls } from "./voice-controls.ts";
import type { Dictation } from "./dictation.ts";
import type { AppWindows } from "./app-windows.ts";

/** Ce dont le menu a besoin des autres modules (lus à chaque affichage : ils sont créés après l'icône). */
export interface TrayDeps {
  texts: Texts;
  quitting(): boolean;
  kernel(): Pick<KernelProcess, "running" | "logDir" | "restart">;
  avatar(): Pick<AvatarWindow, "win" | "state" | "toggleWindow" | "placeHome" | "showWin">;
  voice(): Pick<VoiceControls, "pttOn" | "muted" | "togglePtt" | "toggleMute">;
  dictation(): Pick<Dictation, "dictating" | "toggleDictate">;
  windows(): Pick<AppWindows, "openTextInput" | "openOnboarding">;
  /** Entrées de menu des contributions (voir desktop-contributions.ts). */
  menu(location: "tray"): MenuItemConstructorOptions[];
}

export interface TrayIcon {
  /** Problèmes montrés dans l'icône (id → raison) : les autres modules en ajoutent et en retirent. */
  problems: Map<string, Say>;
  /** Pose l'icône dans la barre des tâches (au démarrage de l'app). */
  create(): void;
  refresh(): void;
}

const dotIcon = (rgb: Rgb) => nativeImage.createFromBuffer(dotPng(rgb));

export function createTray(deps: TrayDeps): TrayIcon {
  const { T, trx, problemName } = deps.texts;
  let tray: Tray | null = null;
  const problems = new Map<string, Say>();

  function create() {
    tray = new Tray(dotIcon(COLORS.starting!));
    tray.on("click", deps.avatar().toggleWindow);
  }

  function refreshTray() {
    // À la fermeture, l'icône et la fenêtre sont détruites avant la fin du noyau : ne plus y toucher.
    if (deps.quitting() || !tray || tray.isDestroyed()) return;
    const win = deps.avatar().win();
    const kernel = deps.kernel().running();
    const dictating = deps.dictation().dictating();
    const shown = problems.size ? "error" : (kernel ? (dictating ? "dictating" : deps.avatar().state()) : "starting");
    tray.setImage(dotIcon(COLORS[shown] ?? COLORS.idle!));
    const lines = [`Floppy : ${problems.size ? T("problem") : (["idle", "listening", "thinking", "speaking", "sleep", "starting", "dictating"].includes(shown) ? T(shown as TextKey) : shown)}`];
    for (const [id, p] of problems) lines.push(`✖ ${problemName(id)} : ${trx(p)}`.slice(0, 120));
    tray.setToolTip(lines.join("\n").slice(0, 127));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: lines[0], enabled: false },
      ...[...problems].map(([id, p]) => ({ label: `✖ ${problemName(id)} : ${trx(p)}`.slice(0, 90), enabled: false })),
      { type: "separator" },
      { label: deps.voice().pttOn() ? T("pttStop") : T("pttStart"), click: () => deps.voice().togglePtt() },
      { label: T("write"), click: () => { deps.windows().openTextInput(); } },
      { label: dictating ? T("dictateStop") : T("dictateStart"), click: () => deps.dictation().toggleDictate() },
      { label: deps.voice().muted() ? T("wake") : T("mute"), click: () => deps.voice().toggleMute() },
      { label: win && !win.isDestroyed() && win.isVisible() ? T("hide") : T("show"), click: () => deps.avatar().toggleWindow() },
      { label: T("replace"), click: () => { deps.avatar().placeHome(); deps.avatar().showWin(); } },
      ...deps.menu("tray"),
      { label: T("firstSetup"), click: () => { deps.windows().openOnboarding(); } },
      { type: "separator" },
      { label: T("restart"), click: () => deps.kernel().restart() },
      { label: T("logs"), click: () => shell.openPath(deps.kernel().logDir()) },
      { label: T("quit"), click: () => app.quit() },
    ]));
  }

  return { problems, create, refresh: refreshTray };
}
