import { contextBridge, ipcRenderer } from "electron";

const api: FloppyDesktopApi = {
  get: () => ipcRenderer.invoke("desktop:get"),
  action: (name) => ipcRenderer.invoke("desktop:action", name),
  onUpdate: (fn) => {
    const listener = (_e: unknown, data: DesktopPayload) => fn(data);
    ipcRenderer.on("desktop:update", listener);
    return () => { ipcRenderer.removeListener("desktop:update", listener); };
  },
};
contextBridge.exposeInMainWorld("floppyDesktop", api);
