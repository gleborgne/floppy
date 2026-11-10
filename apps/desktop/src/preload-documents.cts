// Pont de la fenêtre « Documents » : recevoir un document, choisir un ancien document, ouvrir un lien.
// La page ne peut rien faire d'autre : les liens sont vérifiés (http, https) par le processus principal.
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

const api: FloppyDocsApi = {
  onShow: (cb) => {
    const fn = (_e: IpcRendererEvent, data: DocsShow) => cb(data);
    ipcRenderer.on("documents:show", fn);
    return () => { ipcRenderer.removeListener("documents:show", fn); };
  },
  onList: (cb) => {
    const fn = (_e: IpcRendererEvent, entries: DocEntry[]) => cb(entries);
    ipcRenderer.on("documents:list", fn);
    return () => { ipcRenderer.removeListener("documents:list", fn); };
  },
  // Langue de l'interface changée pendant que la fenêtre est ouverte.
  onLang: (cb) => {
    const fn = (_e: IpcRendererEvent, l: unknown) => cb(String(l));
    ipcRenderer.on("documents:lang", fn);
    return () => { ipcRenderer.removeListener("documents:lang", fn); };
  },
  select: (id) => { ipcRenderer.send("documents:select", String(id)); },
  // Supprimer (déjà confirmé par un 2e clic dans la fenêtre). current : le document affiché.
  remove: (id, current) => { ipcRenderer.send("documents:delete", { id: String(id), current: String(current ?? "") }); },
  link: (url) => { ipcRenderer.send("documents:link", String(url)); },
};
contextBridge.exposeInMainWorld("floppyDocs", api);
