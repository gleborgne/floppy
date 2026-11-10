// Pont de la fenêtre de résultats (A2UI) : recevoir une surface, et signaler un clic sur un bouton.
// La page ne peut rien faire d'autre : l'action « open_url » est vérifiée par le processus principal.
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

const api: FloppyPanelApi = {
  onShow: (cb) => {
    const fn = (_e: IpcRendererEvent, data: PanelShow) => cb(data);
    ipcRenderer.on("panel:show", fn);
    return () => { ipcRenderer.removeListener("panel:show", fn); };
  },
  action: (name, context) => { ipcRenderer.send("panel:action", String(name), context ?? {}); },
};
contextBridge.exposeInMainWorld("floppyPanel", api);
