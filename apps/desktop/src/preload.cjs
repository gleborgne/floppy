// Pont minimal entre l'app et la page de l'avatar (fenêtre isolée, bac à sable).
// - Le MessagePort vers le noyau est remis à la page par window.postMessage (seule façon de passer un port).
// - La page ne peut que signaler son état et demander une hauteur de fenêtre.
const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("body-port", (e) => window.postMessage("floppy:body-port", "*", e.ports));
ipcRenderer.on("text-request", (_e, text) => window.postMessage({ floppyTextRequest: text }, "*"));
ipcRenderer.on("display", (_e, s) => window.postMessage({ floppyDisplay: s }, "*"));
ipcRenderer.on("shortcut", (_e, name) => window.postMessage({ floppyShortcut: name }, "*"));
ipcRenderer.on("document-open", (_e, id) => window.postMessage({ floppyDocumentOpen: String(id) }, "*"));
ipcRenderer.on("document-delete", (_e, d) => window.postMessage({ floppyDocumentDelete: { id: String(d?.id ?? ""), current: String(d?.current ?? "") } }, "*"));
ipcRenderer.on("cursor", (_e, p) => window.postMessage({ floppyCursor: { x: Number(p?.x) || 0, y: Number(p?.y) || 0 } }, "*"));

contextBridge.exposeInMainWorld("floppyHost", {
  setState: (s) => ipcRenderer.send("state", String(s)),
  activity: (kind) => ipcRenderer.send("activity", String(kind ?? "")),
  approvalClosed: () => ipcRenderer.send("approval-closed"),
  openSettings: () => ipcRenderer.send("open-settings"),
  // Déplacer l'avatar (outil vocal) : renvoie { ok, text: { fr, en } }.
  place: (a) => ipcRenderer.invoke("avatar:place", { coin: String(a?.coin ?? ""), ecran: a?.ecran, cible: String(a?.cible ?? "") }),
  // Dictée : effacer `del` caractères puis taper `ins` dans la fenêtre active (mots venus du noyau).
  dictationLevel: (v) => ipcRenderer.send("dictation:level", Number(v) || 0),
  dictation: (d) => ipcRenderer.send("dictation", { del: Number(d?.del) || 0, ins: String(d?.ins ?? "") }),
  // Fenêtre de résultats (A2UI) demandée par le noyau.
  openPanel: (p) => ipcRenderer.send("panel:open", { id: String(p?.id ?? ""), title: String(p?.title ?? ""), a2ui: Array.isArray(p?.a2ui) ? p.a2ui : [] }),
  // Document Markdown demandé par le noyau (rendu et affiché par l'app).
  openDocument: (d) => ipcRenderer.send("documents:open", { id: String(d?.id ?? ""), titre: String(d?.titre ?? ""), markdown: String(d?.markdown ?? ""), liste: Array.isArray(d?.liste) ? d.liste : [] }),
  // Nouvelle liste des documents (après une suppression) : la fenêtre Documents garde le document affiché.
  updateDocuments: (liste) => ipcRenderer.send("documents:list", Array.isArray(liste) ? liste : []),
  setInteractive: (on) => ipcRenderer.send("interactive", Boolean(on)),
  // Déplacement de la fenêtre à la main : "start", "move", "end" (la position vient de la souris, côté app).
  drag: (phase) => ipcRenderer.send("drag", ["start", "move", "end"].includes(phase) ? phase : "end"),
});
