// Fenêtres secondaires de l'app : réglages, « Bienvenue », résultats (A2UI), « Documents » (Markdown), saisie d'une demande ;
// et la langue de l'interface, qui se propage à toutes les fenêtres.
// Propriétaire de ces fenêtres et des conversations de l'assistant ouvertes depuis les réglages.
import type { BrowserWindow } from "electron";
import { renderMarkdown } from "./markdown.ts";
import { safeWindow, bringToFront } from "./windows.ts";
import { pageFile } from "./ui.ts";
import type { Msg } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { VoiceControls } from "./voice-controls.ts";
import type { Dictation } from "./dictation.ts";
import type { createDesktopContributions } from "./desktop-contributions.ts";

export const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/;
/** Liste des documents venue de la page de l'avatar : nettoyée avant d'aller dans la fenêtre. */
export const cleanDocList = (l: unknown) => (Array.isArray(l) ? l : []).slice(0, 60)
  .filter((d: Msg) => d && DOC_ID.test(String(d.id)))
  .map((d: Msg) => ({ id: String(d.id), titre: String(d.titre ?? "").slice(0, 200), date: String(d.date ?? ""), tags: Array.isArray(d.tags) ? d.tags.map(String).slice(0, 10) : [] }));

export interface AppWindowsDeps {
  texts: Texts;
  contributions: Pick<ReturnType<typeof createDesktopContributions>, "language">;
  refreshTray(): void;
  kernel(): Pick<KernelProcess, "kernel" | "hasBodyPort">;
  avatar(): Pick<AvatarWindow, "win" | "winReady" | "display" | "activity">;
  voice(): Pick<VoiceControls, "setMuted">;
  dictation(): Pick<Dictation, "sendLang">;
}

export interface AppWindows {
  settingsWin(): BrowserWindow | null;
  onbWin(): BrowserWindow | null;
  panelWin(): BrowserWindow | null;
  docsWin(): BrowserWindow | null;
  textWin(): BrowserWindow | null;
  /** Conversations de l'assistant ouvertes depuis la fenêtre des réglages (fermées avec elle). */
  coderSessions: Set<string>;
  /** Langue de l'interface reçue du noyau : titres et pages des fenêtres suivent tout de suite. */
  setLang(l: unknown): void;
  openPanel(data: Msg | undefined): void;
  openDocuments(m: Msg | undefined): void;
  openSettings(): BrowserWindow;
  openOnboarding(): BrowserWindow;
  showSettingsConfirmed(): Promise<void>;
  openTextInput(): BrowserWindow;
  submitText(e: { sender: unknown }, raw: unknown): boolean;
}

export function createAppWindows(deps: AppWindowsDeps): AppWindows {
  const { texts } = deps;
  const { T, both, textError } = texts;
  const lang = () => texts.lang();
  const refreshTray = () => deps.refreshTray();
  const kernel = () => deps.kernel().kernel();
  let settingsWin: BrowserWindow | null = null;
  let onbWin: BrowserWindow | null = null;               // fenêtre « Bienvenue » (premier lancement)
  let panelWin: BrowserWindow | null = null;
  let docsWin: BrowserWindow | null = null;
  let textWin: BrowserWindow | null = null;             // saisie envoyée sur le corps vocal de l'avatar
  const coderSessions = new Set<string>(); // conversations de l'assistant ouvertes depuis la fenêtre des réglages

  function setLang(l: unknown): void {
    if (!texts.setLangValue(l)) return;
    const lang = texts.lang();
    const win = deps.avatar().win();
    deps.contributions.language();
    settingsWin?.setTitle(T("settingsTitle"));
    onbWin?.setTitle(T("onboardingTitle"));
    textWin?.setTitle(T("textTitle"));
    textWin?.webContents.send("text:lang", lang);
    // Les autres fenêtres suivent aussi la langue de l'interface, tout de suite.
    if (docsWin && !docsWin.isDestroyed()) docsWin.webContents.send("documents:lang", lang);
    deps.dictation().sendLang(lang);
    if (win && !win.isDestroyed() && deps.avatar().winReady()) win.webContents.send("display", { ...deps.avatar().display(), lang });
    refreshTray();
  }

  // ------------------------------------------------------------------ fenêtre de résultats (A2UI)
  function openPanel(data: Msg | undefined): void {
    const payload = { title: String(data?.title ?? "").slice(0, 200), a2ui: Array.isArray(data?.a2ui) ? data.a2ui : [], lang: lang() };
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.webContents.send("panel:show", payload);
      bringToFront(panelWin);
      return;
    }
    panelWin = safeWindow({ size: { width: 620, height: 720, minWidth: 380, minHeight: 300 }, title: T("panelTitle"), background: "#0b0f15", preload: "preload-panel.cjs" });
    panelWin.loadFile(pageFile("panel"));
    panelWin.webContents.once("did-finish-load", () => { panelWin?.webContents.send("panel:show", payload); bringToFront(panelWin); });
    panelWin.on("closed", () => { panelWin = null; });
  }

  // ------------------------------------------------------------------ fenêtre « Documents » (Markdown)
  // Le Markdown est rendu ici (Node), jamais dans la fenêtre : elle ne reçoit que du HTML nettoyé (voir markdown.mjs).
  function openDocuments(m: Msg | undefined): void {
    const liste = cleanDocList(m?.liste);
    const payload = { id: String(m?.id ?? ""), titre: String(m?.titre ?? "").slice(0, 200), html: renderMarkdown(m?.markdown), liste, lang: lang() };
    if (docsWin && !docsWin.isDestroyed()) {
      docsWin.webContents.send("documents:show", payload);
      bringToFront(docsWin);
      return;
    }
    docsWin = safeWindow({ size: { width: 1020, height: 760, minWidth: 520, minHeight: 320 }, title: T("documentsTitle"), background: "#0b0f15", preload: "preload-documents.cjs" });
    docsWin.loadFile(pageFile("documents"));
    docsWin.webContents.once("did-finish-load", () => { docsWin?.webContents.send("documents:show", payload); bringToFront(docsWin); });
    docsWin.on("closed", () => { docsWin = null; });
  }

  // ------------------------------------------------------------------ fenêtre des réglages
  function openSettings() {
    if (settingsWin) { bringToFront(settingsWin); return settingsWin; }
    settingsWin = safeWindow({ size: { width: 1180, height: 760, minWidth: 480, minHeight: 420 }, title: T("settingsTitle"), background: "#0d1118", preload: "preload-settings.cjs" });
    // Vérification : FLOPPY_SETTINGS_PAGE=<rubrique> ouvre les réglages sur cette rubrique (avec FLOPPY_SNAPSHOT : image).
    const page = process.env.FLOPPY_SETTINGS_PAGE;
    settingsWin.loadFile(pageFile("settings"), page ? { hash: page } : undefined);
    settingsWin.once("ready-to-show", () => bringToFront(settingsWin));
    settingsWin.on("closed", () => {
      settingsWin = null;
      for (const id of coderSessions) kernel()?.postMessage({ type: "coder.close", sessionId: id });
      coderSessions.clear();
    });
    kernel()?.postMessage({ type: "settings.get" });
    kernel()?.postMessage({ type: "items.get" });
    return settingsWin;
  }

  // ------------------------------------------------------------------ fenêtre « Bienvenue » (premier lancement)
  function openOnboarding() {
    if (onbWin && !onbWin.isDestroyed()) { bringToFront(onbWin); return onbWin; }
    onbWin = safeWindow({ size: { width: 820, height: 700, minWidth: 420, minHeight: 480 }, title: T("onboardingTitle"), background: "#0b0f15", preload: "preload-onboarding.cjs" });
    onbWin.loadFile(pageFile("onboarding"));
    onbWin.once("ready-to-show", () => bringToFront(onbWin));
    onbWin.on("closed", () => { onbWin = null; });
    return onbWin;
  }

  async function showSettingsConfirmed(): Promise<void> {
    const target = openSettings();
    if (target.webContents.isLoadingMainFrame()) await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        target.webContents.removeListener("did-finish-load", loaded);
        target.webContents.removeListener("did-fail-load", failed);
        target.removeListener("closed", closed);
      };
      const loaded = () => { cleanup(); resolve(); };
      const failed = (_e: unknown, _code: number, description: string, _url: string, mainFrame: boolean) => { if (mainFrame) { cleanup(); reject(new Error(description)); } };
      const closed = () => { cleanup(); reject(textError(both("closedWhileLoading"))); };
      const timer = setTimeout(() => { cleanup(); reject(textError(both("loadTooLong"))); }, 8000);
      target.webContents.once("did-finish-load", loaded);
      target.webContents.on("did-fail-load", failed);
      target.once("closed", closed);
    });
    bringToFront(target);
    if (target.isDestroyed() || !target.isVisible()) throw textError(both("notVisible"));
  }

  // ------------------------------------------------------------------ saisie d'une demande
  function openTextInput() {
    if (textWin && !textWin.isDestroyed()) { bringToFront(textWin); textWin.webContents.send("text:focus"); return textWin; }
    textWin = safeWindow({ size: { width: 560, height: 340, minWidth: 360, minHeight: 320 }, title: T("textTitle"), preload: "preload-text.cjs" });
    textWin.loadFile(pageFile("text"));
    textWin.webContents.once("did-finish-load", () => textWin?.webContents.send("text:lang", lang()));
    textWin.once("ready-to-show", () => { bringToFront(textWin); textWin?.webContents.send("text:focus"); });
    textWin.on("closed", () => { textWin = null; });
    return textWin;
  }
  /** N'accepte que la fenêtre de saisie et un avatar connecté ; un échec conserve le brouillon. */
  function submitText(e: { sender: unknown }, raw: unknown): boolean {
    const win = deps.avatar().win();
    if (!textWin || e.sender !== textWin.webContents) return false;
    if (typeof raw !== "string" || !raw.trim() || raw.length > 10000 || !kernel() || !deps.kernel().hasBodyPort() || !deps.avatar().winReady() || !win || win.isDestroyed()) return false;
    deps.avatar().activity();
    deps.voice().setMuted(false);
    win.webContents.send("text-request", raw.trim());
    refreshTray();
    return true;
  }

  return {
    settingsWin: () => settingsWin, onbWin: () => onbWin, panelWin: () => panelWin, docsWin: () => docsWin, textWin: () => textWin,
    coderSessions, setLang, openPanel, openDocuments, openSettings, openOnboarding, showSettingsConfirmed, openTextInput, submitText,
  };
}
