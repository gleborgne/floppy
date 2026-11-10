// Canaux IPC des pages (avatar, réglages, « Bienvenue », résultats, documents, saisie, dictée) vers le processus principal.
// Chaque canal vérifie d'où vient l'appel (`e.sender`) avant d'agir ; l'état appartient aux modules appelés, pas à celui-ci.
import { shell, ipcMain, dialog } from "electron";
import { placeOptions, type Bilingual } from "./placement.ts";
import type { Msg } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { KernelMessages } from "./kernel-messages.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { VoiceControls } from "./voice-controls.ts";
import type { Dictation } from "./dictation.ts";
import type { AppWindows } from "./app-windows.ts";
import { DOC_ID, cleanDocList } from "./app-windows.ts";
import type { createDesktopContributions } from "./desktop-contributions.ts";

export interface IpcDeps {
  texts: Texts;
  contributions: Pick<ReturnType<typeof createDesktopContributions>, "get" | "action">;
  refreshTray(): void;
  kernel(): Pick<KernelProcess, "kernel" | "request" | "coderRequest">;
  messages(): Pick<KernelMessages, "lastSettings" | "lastOnb" | "hasItems" | "itemsPayload">;
  avatar(): Pick<AvatarWindow, "win" | "setState" | "setApprovalOpen" | "activity" | "settleIdle" | "placeAvatar" | "dragWindow">;
  voice(): Pick<VoiceControls, "stateChanged">;
  dictation(): Pick<Dictation, "onDictation" | "onLevel" | "onStop">;
  windows(): Pick<AppWindows, "settingsWin" | "onbWin" | "panelWin" | "docsWin" | "textWin" | "coderSessions" | "openSettings" | "openOnboarding" | "openPanel" | "openDocuments" | "submitText">;
}

/** Branche tous les canaux (une fois, quand l'app est prête). */
export function registerIpc(deps: IpcDeps): void {
  const { T } = deps.texts;
  const lang = () => deps.texts.lang();
  const kernel = () => deps.kernel().kernel();
  const kernelRequest = (msg: Msg): Promise<any> => deps.kernel().request(msg);
  const coderCall = (msg: Msg): Promise<any> => deps.kernel().coderRequest(msg);
  const { contributions, windows, avatar, messages } = deps;
  const coderSessions = windows().coderSessions;
  const refreshTray = () => deps.refreshTray();
  const openSettings = () => windows().openSettings();
  const openOnboarding = () => windows().openOnboarding();

  ipcMain.on("state", (_e, s) => {
    avatar().setState(s);
    deps.voice().stateChanged(s);
    if (s === "listening" || s === "thinking" || s === "speaking") avatar().activity(); else if (s === "idle") avatar().settleIdle();
    refreshTray();
  });
  ipcMain.on("activity", (_e, kind) => { avatar().setApprovalOpen(kind === "approval"); avatar().activity(); });
  ipcMain.on("approval-closed", () => { avatar().setApprovalOpen(false); avatar().settleIdle(); });
  ipcMain.handle("text:submit", (e, text) => windows().submitText(e, text));
  ipcMain.handle("desktop:get", (e, ...args) => contributions.get(e, ...args));
  ipcMain.handle("desktop:action", (e, action, ...args) => contributions.action(e, action, ...args));
  ipcMain.on("text:close", (e) => { const textWin = windows().textWin(); if (textWin && e.sender === textWin.webContents) textWin.close(); });
  ipcMain.on("open-settings", () => openSettings());
  // Réponse : { ok, text: { fr, en } } ; la page de l'avatar choisit la langue de l'assistant (c'est Floppy qui le dit).
  ipcMain.handle("avatar:place", (e, a) => {
    const win = avatar().win();
    if (!win || e.sender !== win.webContents) throw new Error("refusé");
    try {
      return { ok: true, text: avatar().placeAvatar(placeOptions(a)) };
    } catch (error) {
      const err = error as { text?: Bilingual; message?: unknown };
      return { ok: false, text: err?.text ?? String(err?.message ?? error) };
    }
  });
  // Dictée : le noyau envoie les mots confirmés ; seule la page de l'avatar peut les faire taper.
  ipcMain.on("dictation", (e, d) => deps.dictation().onDictation(e, d));
  ipcMain.on("dictation:level", (e, v) => deps.dictation().onLevel(e, v));
  ipcMain.on("dictation:stop", (e) => deps.dictation().onStop(e));
  // Fenêtre de résultats : seulement à la demande de la page de l'avatar ; actions seulement depuis la fenêtre.
  ipcMain.on("panel:open", (e, data) => { const win = avatar().win(); if (win && e.sender === win.webContents) windows().openPanel(data); });
  ipcMain.on("panel:action", async (e, name, context) => {
    const panelWin = windows().panelWin();
    if (!panelWin || e.sender !== panelWin.webContents) return;
    if (name === "ouvrir_url") {
      try {
        const u = new URL(String(context?.url ?? ""));
        if (u.protocol === "https:" || u.protocol === "http:") await shell.openExternal(u.toString());
      } catch { /* adresse invalide : rien */ }
    }
  });
  // Fenêtre « Documents » : ouverte seulement à la demande de la page de l'avatar ; le reste seulement depuis la fenêtre.
  ipcMain.on("documents:open", (e, data) => { const win = avatar().win(); if (win && e.sender === win.webContents) windows().openDocuments(data); });
  ipcMain.on("documents:select", (_e, id) => {
    const docsWin = windows().docsWin();
    if (!docsWin || _e.sender !== docsWin.webContents) return;
    if (DOC_ID.test(String(id))) avatar().win()?.webContents.send("document-open", String(id)); // la page de l'avatar le transmet au noyau
  });
  // Supprimer un document : demandé par la fenêtre Documents (2 clics), transmis au noyau par la page de l'avatar.
  ipcMain.on("documents:delete", (e, d) => {
    const docsWin = windows().docsWin();
    if (!docsWin || e.sender !== docsWin.webContents) return;
    const id = String(d?.id ?? "");
    const current = String(d?.current ?? "");
    if (!DOC_ID.test(id)) return;
    avatar().win()?.webContents.send("document-delete", { id, current: DOC_ID.test(current) ? current : "" });
  });
  // Nouvelle liste (après une suppression) : de la page de l'avatar vers la fenêtre Documents, si elle est ouverte.
  ipcMain.on("documents:list", (e, entries) => {
    const win = avatar().win();
    if (!win || e.sender !== win.webContents) return;
    const docsWin = windows().docsWin();
    if (docsWin && !docsWin.isDestroyed()) docsWin.webContents.send("documents:list", cleanDocList(entries));
  });
  ipcMain.on("documents:link", async (e, url) => {
    const docsWin = windows().docsWin();
    if (!docsWin || e.sender !== docsWin.webContents) return;
    try {
      const u = new URL(String(url));
      if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") await shell.openExternal(u.toString());
    } catch { /* adresse invalide : rien */ }
  });
  // Fenêtre des réglages : seulement depuis sa propre page.
  const fromSettings = (e: { sender: unknown }) => { const settingsWin = windows().settingsWin(); return settingsWin && e.sender === settingsWin.webContents; };
  // Fenêtre « Bienvenue » : seulement depuis sa propre page.
  const fromOnb = (e: { sender: unknown }) => { const onbWin = windows().onbWin(); return onbWin && !onbWin.isDestroyed() && e.sender === onbWin.webContents; };
  ipcMain.handle("onboarding:get", (e, o) => fromOnb(e) ? kernelRequest({
    type: "onboarding.get", fresh: o?.fresh === true,
    ...(typeof o?.manualBytes === "number" && o.manualBytes >= 0 && o.manualBytes < 2 ** 50 ? { manualBytes: o.manualBytes } : {}),
  }) : null);
  ipcMain.handle("onboarding:apply", (e, level, brain) => fromOnb(e) ? kernelRequest({ type: "onboarding.apply", level: String(level).slice(0, 40), ...(brain ? { brain: String(brain).slice(0, 200) } : {}) }) : null);
  ipcMain.handle("onboarding:skip", (e) => fromOnb(e) ? kernelRequest({ type: "onboarding.skip" }) : null);
  // Répertoire de travail choisi dans « Bienvenue » : le noyau le note puis repart dans ce dossier (réglage dossier_floppy).
  ipcMain.handle("onboarding:home", async (e) => {
    const onbWin = windows().onbWin();
    if (!fromOnb(e) || !onbWin) return null;
    const r = await dialog.showOpenDialog(onbWin, { title: T("pickTitle"), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return kernelRequest({ type: "settings.set", key: "dossier_floppy", value: r.filePaths[0] });
  });
  ipcMain.on("onboarding:close", (e) => { if (fromOnb(e)) windows().onbWin()?.close(); });
  ipcMain.on("onboarding:settings", (e) => { if (fromOnb(e)) openSettings(); });
  ipcMain.handle("onboarding:state", (e) => (fromSettings(e) ? messages().lastOnb() : null));
  ipcMain.on("open-onboarding", (e) => { const settingsWin = windows().settingsWin(); if (settingsWin && e.sender === settingsWin.webContents) openOnboarding(); });
  ipcMain.handle("settings:get", (e) => {
    if (!fromSettings(e)) return null;
    kernel()?.postMessage({ type: "settings.get" });
    return messages().lastSettings() ?? { list: [], sections: [], plugins: [], slots: [], lang: lang() };
  });
  // Éléments (catalogue) : liste, opérations (ajouter, modifier, activer…), choix d'un fichier ou d'un dossier.
  ipcMain.handle("items:get", (e) => {
    if (!fromSettings(e)) return null;
    kernel()?.postMessage({ type: "items.get" });
    return messages().hasItems() ? messages().itemsPayload() : { providers: [], lang: lang() };
  });
  ipcMain.handle("items:op", (e, op) => {
    if (!fromSettings(e)) return null;
    if (!op || typeof op !== "object" || typeof op.op !== "string" || typeof op.provider !== "string") return { ok: false, text: T("invalid") };
    return kernelRequest({ type: "items.op", op });
  });
  ipcMain.handle("items:pick", async (e, opts) => {
    const settingsWin = windows().settingsWin();
    if (!fromSettings(e) || !settingsWin) return null;
    const o: Msg = opts && typeof opts === "object" ? opts : {};
    const filters = Array.isArray(o.filters)
      ? o.filters.slice(0, 10).map((f) => ({ name: String(f?.name ?? ""), extensions: Array.isArray(f?.extensions) ? f.extensions.slice(0, 20).map((x: unknown) => String(x).replace(/^\./, "")) : [] }))
      : [];
    const r = await dialog.showOpenDialog(settingsWin, {
      title: T("pickTitle"), properties: [o.directory ? "openDirectory" : "openFile"], ...(filters.length && !o.directory ? { filters } : {}),
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle("settings:set", (e, key, value) => fromSettings(e) ? kernelRequest({ type: "settings.set", key: String(key), value }) : null);
  ipcMain.handle("settings:undo", (e) => fromSettings(e) ? kernelRequest({ type: "settings.undo" }) : null);
  // Assistant IA : relais fenêtre des réglages ↔ service « coder » du noyau.
  ipcMain.handle("coder:agents", async (e) => {
    if (!fromSettings(e)) return null;
    const r = await coderCall({ type: "coder.agents" });
    return r.ok ? r.value : null;
  });
  ipcMain.handle("coder:start", async (e, agent, mode) => {
    if (!fromSettings(e)) return null;
    const r = await coderCall({ type: "coder.start", agent: String(agent), mode: String(mode) });
    if (r.ok && r.value) coderSessions.add(r.value);
    return { ok: !!r.ok, sessionId: r.value, error: r.error };
  });
  ipcMain.on("coder:send", (e, id, text) => { if (fromSettings(e)) kernel()?.postMessage({ type: "coder.send", sessionId: String(id), text: String(text) }); });
  ipcMain.on("coder:cancel", (e, id) => { if (fromSettings(e)) kernel()?.postMessage({ type: "coder.cancel", sessionId: String(id) }); });
  ipcMain.on("coder:permission", (e, id, permissionId, allow) => {
    if (fromSettings(e)) kernel()?.postMessage({ type: "coder.permission", sessionId: String(id), permissionId: String(permissionId), allow: allow === true });
  });
  ipcMain.on("coder:close", (e, id) => {
    if (!fromSettings(e)) return;
    coderSessions.delete(String(id));
    kernel()?.postMessage({ type: "coder.close", sessionId: String(id) });
  });
  ipcMain.on("interactive", (_e, on) => avatar().win()?.setIgnoreMouseEvents(!on, { forward: true }));
  // Déplacer l'avatar à la main (la tête n'est plus une zone « drag » : un clic sans bouger la chatouille).
  ipcMain.on("drag", (e, phase) => {
    const win = avatar().win();
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
    avatar().dragWindow(phase);
  });
}
