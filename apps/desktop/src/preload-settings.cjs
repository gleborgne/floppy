// Pont de la fenêtre des réglages : lire, changer, annuler, et recevoir les mises à jour (changements à la voix).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floppySettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (key, value) => ipcRenderer.invoke("settings:set", String(key), value),
  undo: () => ipcRenderer.invoke("settings:undo"),
  // Éléments du catalogue (modèles, voix, connecteurs, corps, avatars).
  items: () => ipcRenderer.invoke("items:get"),
  // Fenêtre « Bienvenue » : refaire le réglage de départ selon la machine.
  openOnboarding: () => ipcRenderer.send("open-onboarding"),
  // Avancement de l'installation de départ (montré dans la rubrique Général).
  onboardingState: () => ipcRenderer.invoke("onboarding:state"),
  onOnboarding: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("onboarding:state", fn);
    return () => ipcRenderer.removeListener("onboarding:state", fn);
  },
  itemOp: (op) => ipcRenderer.invoke("items:op", op),
  pickPath: (opts) => ipcRenderer.invoke("items:pick", {
    directory: !!opts?.directory,
    filters: Array.isArray(opts?.filters) ? opts.filters : [],
  }),
  onItems: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("items:update", fn);
    return () => ipcRenderer.removeListener("items:update", fn);
  },
  // « Ouvre les réglages d'Orca » : la page d'un élément à montrer ({ section, provider, id }).
  onFocus: (cb) => {
    const fn = (_e, target) => cb(target);
    ipcRenderer.on("settings:focus", fn);
    return () => ipcRenderer.removeListener("settings:focus", fn);
  },
  onUpdate: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("settings:update", fn);
    return () => ipcRenderer.removeListener("settings:update", fn);
  },
});

// Assistant IA (service « coder » du noyau, via le processus principal).
contextBridge.exposeInMainWorld("floppyCoder", {
  agents: () => ipcRenderer.invoke("coder:agents"),
  start: (agent, mode) => ipcRenderer.invoke("coder:start", String(agent), String(mode)),
  send: (id, text) => ipcRenderer.send("coder:send", String(id), String(text)),
  cancel: (id) => ipcRenderer.send("coder:cancel", String(id)),
  answer: (id, permissionId, allow) => ipcRenderer.send("coder:permission", String(id), String(permissionId), allow === true),
  close: (id) => ipcRenderer.send("coder:close", String(id)),
  onEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on("coder:event", fn);
    return () => ipcRenderer.removeListener("coder:event", fn);
  },
});
