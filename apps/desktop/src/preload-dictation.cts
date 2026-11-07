// Pont de la pilule de dictée : recevoir le niveau du micro, l'état et la langue, demander l'arrêt. Rien d'autre.
import { contextBridge, ipcRenderer } from "electron";

const api: FloppyDictationApi = {
  onLevel: (cb) => { ipcRenderer.on("dictation:level", (_e, v) => cb(Number(v) || 0)); },
  onTyped: (cb) => { ipcRenderer.on("dictation:typed", () => cb()); },
  onState: (cb) => { ipcRenderer.on("dictation:state", (_e, s) => cb(String(s))); },
  onLang: (cb) => { ipcRenderer.on("dictation:lang", (_e, l) => cb(String(l))); },
  stop: () => { ipcRenderer.send("dictation:stop"); },
};
contextBridge.exposeInMainWorld("floppyDictation", api);
