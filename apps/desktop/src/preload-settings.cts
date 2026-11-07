// Pont de la fenêtre des réglages : lire, changer, annuler, et recevoir les mises à jour (changements à la voix).
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/** Abonnement à un message du processus principal ; renvoie la fonction qui le retire. */
function listen<T>(channel: string, cb: (data: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, data: T) => cb(data);
  ipcRenderer.on(channel, fn);
  return () => { ipcRenderer.removeListener(channel, fn); };
}

const settings: FloppySettingsApi = {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (key, value) => ipcRenderer.invoke("settings:set", String(key), value),
  undo: () => ipcRenderer.invoke("settings:undo"),
  // Éléments du catalogue (modèles, voix, connecteurs, corps, avatars).
  items: () => ipcRenderer.invoke("items:get"),
  // Fenêtre « Bienvenue » : refaire le réglage de départ selon la machine.
  openOnboarding: () => { ipcRenderer.send("open-onboarding"); },
  // Avancement de l'installation de départ (montré dans la rubrique Général).
  onboardingState: () => ipcRenderer.invoke("onboarding:state"),
  onOnboarding: (cb) => listen("onboarding:state", cb),
  itemOp: (op) => ipcRenderer.invoke("items:op", op),
  pickPath: (opts) => ipcRenderer.invoke("items:pick", {
    directory: !!opts?.directory,
    filters: Array.isArray(opts?.filters) ? opts.filters : [],
  }),
  onItems: (cb) => listen("items:update", cb),
  // « Ouvre les réglages d'Orca » : la page d'un élément à montrer ({ section, provider, id }).
  onFocus: (cb) => listen("settings:focus", cb),
  onUpdate: (cb) => listen("settings:update", cb),
};
contextBridge.exposeInMainWorld("floppySettings", settings);

// Assistant IA (service « coder » du noyau, via le processus principal).
const coder: FloppyCoderApi = {
  agents: () => ipcRenderer.invoke("coder:agents"),
  start: (agent, mode) => ipcRenderer.invoke("coder:start", String(agent), String(mode)),
  send: (id, text) => { ipcRenderer.send("coder:send", String(id), String(text)); },
  cancel: (id) => { ipcRenderer.send("coder:cancel", String(id)); },
  answer: (id, permissionId, allow) => { ipcRenderer.send("coder:permission", String(id), String(permissionId), allow === true); },
  close: (id) => { ipcRenderer.send("coder:close", String(id)); },
  onEvent: (cb) => listen("coder:event", cb),
};
contextBridge.exposeInMainWorld("floppyCoder", coder);
