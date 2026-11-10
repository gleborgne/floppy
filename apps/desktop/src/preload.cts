// Pont minimal entre l'app et la page de l'avatar (fenêtre isolée, bac à sable).
// - Le MessagePort vers le noyau est remis à la page par window.postMessage (seule façon de passer un port).
// - La page ne peut que signaler son état et demander une hauteur de fenêtre.
import { contextBridge, ipcRenderer } from "electron";

/** Données venues du processus principal, relues champ par champ avant d'être transmises à la page. */
type Loose = { [key: string]: unknown } | null | undefined;

ipcRenderer.on("body-port", (e) => window.postMessage("floppy:body-port", "*", [...e.ports]));
ipcRenderer.on("text-request", (_e, text) => window.postMessage({ floppyTextRequest: text }, "*"));
ipcRenderer.on("display", (_e, s) => window.postMessage({ floppyDisplay: s }, "*"));
ipcRenderer.on("shortcut", (_e, name) => window.postMessage({ floppyShortcut: name }, "*"));
ipcRenderer.on("document-open", (_e, id) => window.postMessage({ floppyDocumentOpen: String(id) }, "*"));
ipcRenderer.on("document-delete", (_e, d: Loose) => window.postMessage({ floppyDocumentDelete: { id: String(d?.id ?? ""), current: String(d?.current ?? "") } }, "*"));
// Conversation : la fenêtre est visible (la bulle s'efface), ou l'utilisateur y a répondu à un accord ou à un choix.
ipcRenderer.on("chat-open", (_e, on) => window.postMessage({ floppyChatOpen: on === true }, "*"));
ipcRenderer.on("chat-approval", (_e, d: Loose) => window.postMessage({ floppyChatApproval: { id: String(d?.id ?? ""), ok: d?.ok === true } }, "*"));
ipcRenderer.on("chat-stop-listening", () => window.postMessage({ floppyChatStopListening: true }, "*"));
ipcRenderer.on("chat-choice", (_e, d: Loose) => window.postMessage({ floppyChatChoice: { id: String(d?.id ?? ""), option: String(d?.option ?? "") } }, "*"));
ipcRenderer.on("cursor", (_e, p: Loose) => window.postMessage({ floppyCursor: { x: Number(p?.x) || 0, y: Number(p?.y) || 0 } }, "*"));

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const CHAT_TYPES = ["transcript", "reply.delta", "reply.done", "notify", "card", "error", "approval.request", "approval.closed", "choice.request", "choice.closed", "session.reset"];
/** Ce que la page relaie à la conversation : types connus seulement, champs relus un à un (le processus principal les vérifie encore). */
function chatEvent(m: Loose): { [key: string]: unknown } | null {
  const type = typeof m?.type === "string" ? m.type : "";
  if (!m || !CHAT_TYPES.includes(type)) return null;
  switch (type) {
    case "transcript": return { type, text: text(m.text, 10000), final: m.final === true };
    case "reply.delta": case "reply.done": case "error": return { type, text: text(m.text, 100000) };
    case "notify": return { type, text: text(m.text, 10000), important: m.important === true };
    case "card": return { type, title: text(m.title, 300), lines: Array.isArray(m.lines) ? m.lines.slice(0, 100).map((l) => text(l, 2000)) : [] };
    case "approval.request": return { type, id: text(m.id, 200), summary: text(m.summary, 2000), ttl_s: Number(m.ttl_s) || 0 };
    case "approval.closed": return { type, id: text(m.id, 200), ok: m.ok === true };
    case "choice.request": return {
      type, id: text(m.id, 200), title: text(m.title, 300), ttl_s: Number(m.ttl_s) || 0,
      options: Array.isArray(m.options) ? m.options.slice(0, 50).map((o: Loose) => ({ id: text(o?.id, 200), label: text(o?.label, 200), detail: text(o?.detail, 400) })) : [],
    };
    case "choice.closed": return { type, id: text(m.id, 200), picked: text(m.picked, 200) };
    default: return { type };
  }
}

const api: FloppyHostApi = {
  setState: (s) => { ipcRenderer.send("state", String(s)); },
  activity: (kind) => { ipcRenderer.send("activity", String(kind ?? "")); },
  approvalClosed: () => { ipcRenderer.send("approval-closed"); },
  openSettings: () => { ipcRenderer.send("open-settings"); },
  // Déplacer l'avatar (outil vocal) : renvoie { ok, text: { fr, en } }.
  place: (a) => ipcRenderer.invoke("avatar:place", { corner: String(a?.corner ?? ""), screen: a?.screen, target: String(a?.target ?? "") }),
  // Dictée : effacer `del` caractères puis taper `ins` dans la fenêtre active (mots venus du noyau).
  dictationLevel: (v) => { ipcRenderer.send("dictation:level", Number(v) || 0); },
  dictation: (d) => { ipcRenderer.send("dictation", { del: Number(d?.del) || 0, ins: String(d?.ins ?? "") }); },
  // Fenêtre de résultats (A2UI) demandée par le noyau.
  openPanel: (p) => { ipcRenderer.send("panel:open", { id: String(p?.id ?? ""), title: String(p?.title ?? ""), a2ui: Array.isArray(p?.a2ui) ? p.a2ui : [] }); },
  // Document Markdown demandé par le noyau (rendu et affiché par l'app).
  openDocument: (d) => { ipcRenderer.send("documents:open", { id: String(d?.id ?? ""), title: String(d?.title ?? ""), markdown: String(d?.markdown ?? ""), entries: Array.isArray(d?.entries) ? d.entries : [] }); },
  // Nouvelle liste des documents (après une suppression) : la fenêtre Documents garde le document affiché.
  updateDocuments: (entries) => { ipcRenderer.send("documents:list", Array.isArray(entries) ? entries : []); },
  // Conversation : ce que le noyau envoie est relayé à la fenêtre ; la bulle peut aussi l'ouvrir.
  chat: (m) => { const event = chatEvent(m); if (event) ipcRenderer.send("chat:event", event); },
  openChat: () => { ipcRenderer.send("chat:open"); },
  setInteractive: (on) => { ipcRenderer.send("interactive", Boolean(on)); },
  // Déplacement de la fenêtre à la main : "start", "move", "end" (la position vient de la souris, côté app).
  drag: (phase) => { ipcRenderer.send("drag", ["start", "move", "end"].includes(phase) ? phase : "end"); },
};
contextBridge.exposeInMainWorld("floppyHost", api);
