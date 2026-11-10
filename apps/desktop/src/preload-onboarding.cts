// Pont de la fenêtre « Bienvenue » (premier lancement) : lire la machine et les niveaux, installer, suivre l'avancement.
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

const api: FloppyOnboardingApi = {
  plan: (opts) => ipcRenderer.invoke("onboarding:get", {
    fresh: opts?.fresh === true,
    ...(typeof opts?.manualBytes === "number" ? { manualBytes: opts.manualBytes } : {}),
  }),
  setLanguage: (lang, opts) => ipcRenderer.invoke("onboarding:language", String(lang), typeof opts?.manualBytes === "number" ? opts.manualBytes : undefined),
  prepareListening: () => ipcRenderer.invoke("onboarding:listen"),
  extras: () => ipcRenderer.invoke("onboarding:extras"),
  setWay: (way, value) => ipcRenderer.invoke("onboarding:way", String(way), String(value)),
  setTool: (id, on) => ipcRenderer.invoke("onboarding:tool", String(id), on === true),
  apply: (selection) => ipcRenderer.invoke("onboarding:apply", {
    ...(selection?.brain !== undefined ? { brain: String(selection.brain) } : {}),
    ...(selection?.stt !== undefined ? { stt: String(selection.stt) } : {}),
    ...(selection?.tts !== undefined ? { tts: String(selection.tts) } : {}),
  }),
  skip: () => ipcRenderer.invoke("onboarding:skip"),
  /** Choisir le répertoire de travail (sélecteur de dossiers) ; Floppy repart dans ce dossier. */
  chooseHome: () => ipcRenderer.invoke("onboarding:home"),
  close: () => { ipcRenderer.send("onboarding:close"); },
  openSettings: () => { ipcRenderer.send("onboarding:settings"); },
  onState: (cb) => {
    const fn = (_e: IpcRendererEvent, s: OnboardingState) => cb(s);
    ipcRenderer.on("onboarding:state", fn);
    return () => { ipcRenderer.removeListener("onboarding:state", fn); };
  },
};
contextBridge.exposeInMainWorld("floppyOnboarding", api);
