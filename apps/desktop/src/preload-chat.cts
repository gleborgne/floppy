// Pont de la fenêtre « Conversation » : recevoir le journal, envoyer un texte, répondre à un accord ou à un choix, ouvrir un lien.
// La page ne peut rien faire d'autre : le processus principal vérifie l'expéditeur de chaque canal et les valeurs.
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/** S'abonner à un canal du processus principal ; rend de quoi se désabonner. */
const listen = <T,>(channel: string, read: (value: unknown) => T, cb: (value: T) => void) => {
  const fn = (_e: IpcRendererEvent, value: unknown) => cb(read(value));
  ipcRenderer.on(channel, fn);
  return () => { ipcRenderer.removeListener(channel, fn); };
};

const api: FloppyChatApi = {
  submit: (text) => ipcRenderer.invoke("chat:submit", String(text)),
  close: () => { ipcRenderer.send("chat:close"); },
  answerApproval: (id, ok) => { ipcRenderer.send("chat:approval", String(id), ok === true); },
  answerChoice: (id, option) => { ipcRenderer.send("chat:choice", String(id), String(option)); },
  stopListening: () => { ipcRenderer.send("chat:stop-listening"); },
  link: (url) => { ipcRenderer.send("chat:link", String(url)); },
  onInit: (cb) => listen("chat:init", (v) => v as ChatInit, cb),
  onChange: (cb) => listen("chat:change", (v) => v as ChatDelta, cb),
  onLang: (cb) => listen("chat:lang", String, cb),
  onState: (cb) => listen("chat:state", String, cb),
  onFocus: (cb) => listen("chat:focus", () => undefined, () => cb()),
};
contextBridge.exposeInMainWorld("floppyChat", api);
