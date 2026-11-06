// Pont de la fenêtre de résultats (A2UI) : recevoir une surface, et signaler un clic sur un bouton.
// La page ne peut rien faire d'autre : l'action « ouvrir_url » est vérifiée par le processus principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floppyPanel", {
  onShow: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("panel:show", fn);
    return () => ipcRenderer.removeListener("panel:show", fn);
  },
  action: (name, context) => ipcRenderer.send("panel:action", String(name), context ?? {}),
});
