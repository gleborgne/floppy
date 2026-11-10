// Dictée (Ctrl+Alt+D) : le texte entendu est tapé dans la fenêtre active ; la pilule en bas de l'écran la montre.
// Propriétaire de l'état « dictée en cours », de la frappe clavier (chargée à la première dictée) et de la pilule.
import { BrowserWindow, screen } from "electron";
import { Typer } from "./typer.ts";
import { pageFile, preloadFile } from "./ui.ts";
import type { Bilingual } from "./placement.ts";
import type { Lang } from "./main-texts.ts";
import type { Say } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { AvatarWindow } from "./avatar.ts";

export interface DictationDeps {
  texts: Texts;
  /** Journal du noyau (kernel.log). */
  kernelLog: { write(chunk: string | Buffer): void };
  /** Problèmes montrés dans l'icône (propriétaire : l'icône). */
  problems: Pick<Map<string, Say>, "set">;
  refreshTray(): void;
  avatar(): Pick<AvatarWindow, "win">;
}

export interface Dictation {
  dictating(): boolean;
  toggleDictate(): void;
  /** La langue de l'interface a changé : la pilule la suit. */
  sendLang(lang: Lang): void;
  /** Mots confirmés envoyés par le noyau : seule la page de l'avatar peut les faire taper. */
  onDictation(e: { sender: unknown }, d: any): void;
  onLevel(e: { sender: unknown }, v: unknown): void;
  /** Arrêt demandé depuis la pilule. */
  onStop(e: { sender: unknown }): void;
}

export function createDictation(deps: DictationDeps): Dictation {
  const { texts, kernelLog, problems } = deps;
  const lang = () => texts.lang();
  const refreshTray = () => deps.refreshTray();
  let dictating = false;          // dictée en cours (Ctrl+Alt+D) : le texte est tapé dans la fenêtre active
  let typer: Typer | null = null;
  let dictWin: BrowserWindow | null = null;             // pilule de dictée (en bas de l'écran, ne prend jamais le focus)
  let dictHideTimer: NodeJS.Timeout | undefined;               // frappes clavier de la dictée (chargé à la première dictée)

  /** Pilule de dictée : en bas au centre de l'écran où est la souris, sans jamais prendre le focus. */
  function showDictationPill() {
    clearTimeout(dictHideTimer);
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const w = 240, h = 56;
    const bounds = { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + wa.height - h - 16, width: w, height: h };
    if (!dictWin || dictWin.isDestroyed()) {
      dictWin = new BrowserWindow({
        ...bounds, frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
        focusable: false, hasShadow: false, show: false, backgroundColor: "#00000000",
        webPreferences: { preload: preloadFile("preload-dictation.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      dictWin.setAlwaysOnTop(true, "screen-saver");
      dictWin.loadFile(pageFile("dictation"));
      dictWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      dictWin.webContents.on("will-navigate", (e) => e.preventDefault());
      dictWin.webContents.once("did-finish-load", () => dictWin?.webContents.send("dictation:lang", lang()));
      dictWin.once("ready-to-show", () => { if (dictating) { dictWin?.showInactive(); dictWin?.webContents.send("dictation:state", "listening"); } });
      dictWin.on("closed", () => { dictWin = null; });
    } else {
      dictWin.setBounds(bounds);
      dictWin.showInactive();
      dictWin.webContents.send("dictation:state", "listening");
    }
  }
  /** Après l'arrêt : les dernières phrases arrivent encore (environ 1 s), puis la pilule disparaît. */
  function finishDictationPill() {
    if (!dictWin || dictWin.isDestroyed()) return;
    dictWin.webContents.send("dictation:state", "finishing");
    clearTimeout(dictHideTimer);
    dictHideTimer = setTimeout(() => { if (!dictating) dictWin?.hide(); }, 1500);
  }

  function toggleDictate() {
    dictating = !dictating;
    if (dictating) {
      try { typer ??= new Typer((msg) => { kernelLog.write(`[app] ${msg}
`); console.log(`[app] ${msg}`); }); }
      catch (e) { const err = e as { text?: Bilingual; message?: unknown }; dictating = false; problems.set("dictée", err?.text ?? String(err?.message ?? e)); refreshTray(); return; }
      typer.reset();
      showDictationPill();
    } else finishDictationPill();
    deps.avatar().win()?.webContents.send("shortcut", dictating ? "dictate-on" : "dictate-off");
    refreshTray();
  }

  return {
    dictating: () => dictating,
    toggleDictate,
    sendLang: (lang) => { if (dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:lang", lang); },
    onDictation(e, d) {
      const win = deps.avatar().win();
      if (!win || e.sender !== win.webContents || !typer) return;
      const del = Math.max(0, Math.min(500, Number(d?.del) || 0));
      const ins = String(d?.ins ?? "").slice(0, 5000);
      if (del || ins) {
        void typer.edit(del, ins);
        if (dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:typed");
        // Une phrase finale arrive après l'arrêt : la pilule reste un peu, le temps de la voir tapée.
        if (!dictating) finishDictationPill();
      }
    },
    onLevel(e, v) {
      const win = deps.avatar().win();
      if (win && e.sender === win.webContents && dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:level", Number(v) || 0);
    },
    onStop(e) { if (dictWin && e.sender === dictWin.webContents && dictating) toggleDictate(); },
  };
}
