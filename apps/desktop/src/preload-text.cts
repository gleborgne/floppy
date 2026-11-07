import { contextBridge, ipcRenderer } from "electron";

const api: FloppyTextApi = {
  submit: (text) => ipcRenderer.invoke("text:submit", text),
  close: () => { ipcRenderer.send("text:close"); },
  onLang: (fn) => { ipcRenderer.on("text:lang", (_e, lang) => fn(lang)); },
  onFocus: (fn) => { ipcRenderer.on("text:focus", () => fn()); },
};
contextBridge.exposeInMainWorld("floppyText", api);
