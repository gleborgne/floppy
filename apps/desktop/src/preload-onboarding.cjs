// Pont de la fenêtre « Bienvenue » (premier lancement) : lire la machine et les niveaux, installer, suivre l'avancement.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floppyOnboarding", {
  plan: (opts) => ipcRenderer.invoke("onboarding:get", {
    fresh: opts?.fresh === true,
    ...(typeof opts?.manualBytes === "number" ? { manualBytes: opts.manualBytes } : {}),
  }),
  apply: (level, brain) => ipcRenderer.invoke("onboarding:apply", String(level), brain ? String(brain) : ""),
  skip: () => ipcRenderer.invoke("onboarding:skip"),
  /** Choisir le répertoire de travail (sélecteur de dossiers) ; Floppy repart dans ce dossier. */
  chooseHome: () => ipcRenderer.invoke("onboarding:home"),
  close: () => ipcRenderer.send("onboarding:close"),
  openSettings: () => ipcRenderer.send("onboarding:settings"),
  onState: (cb) => {
    const fn = (_e, s) => cb(s);
    ipcRenderer.on("onboarding:state", fn);
    return () => ipcRenderer.removeListener("onboarding:state", fn);
  },
});
