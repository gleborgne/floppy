// Fenêtres secondaires de l'app (résultats, documents, réglages, bienvenue) : une seule recette sûre.
// Page locale, sans menu ; ni nouvelle fenêtre ni navigation ; le pont vers l'app passe par un preload isolé.
import { app, BrowserWindow } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { preloadFile } from "./ui.ts";

export interface SafeWindowOptions {
  size: Pick<BrowserWindowConstructorOptions, "width" | "height" | "minWidth" | "minHeight">;
  title: string;
  background?: string;
  /** Nom du fichier preload compilé (dans build/, voir ui.ts). */
  preload: string;
  /** Sans la barre de titre du système : la page dessine la sienne (zone à glisser, bouton fermer). Le bord reste étirable. */
  frameless?: boolean;
}

/** Fenêtre secondaire sûre (cachée : la montrer quand elle est prête). */
export function safeWindow({ size, title, background = "#0b0f15", preload, frameless = false }: SafeWindowOptions): BrowserWindow {
  const w = new BrowserWindow({
    ...size, title, backgroundColor: background, autoHideMenuBar: true, show: false,
    // Pas d'agrandissement plein écran sans cadre : un double-clic sur la barre dessinée ne doit rien faire.
    ...(frameless ? { frame: false, maximizable: false, fullscreenable: false } : {}),
    webPreferences: { preload: preloadFile(preload), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  return w;
}

// Windows empêche une app en arrière-plan de prendre le premier plan (demande à la voix : l'utilisateur est dans
// une autre app). On passe la fenêtre « toujours devant » un instant, puis on rend la main.
export function bringToFront(w: BrowserWindow | null | undefined): void {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.setAlwaysOnTop(true, "screen-saver");
  w.moveTop();
  app.focus({ steal: true });
  w.focus();
  setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 400);
}
