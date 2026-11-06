// Entrée du noyau dans l'app : tourne dans un utilityProcess d'Electron (Node 24 inclus dans Electron 45).
// Même démarrage que `floppy start` (boot.ts). Le plugin body-electron reçoit ici les MessagePort de l'avatar.
import { boot } from "@floppy/cli/boot";
import { T, tr, errorText, type CoderService } from "@floppy/core";

interface ParentPort {
  on(ev: "message", fn: (e: { data: unknown }) => void): void;
  postMessage(data: unknown): void;
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
const configPath = process.argv[2] ?? process.env.FLOPPY_CONFIG ?? "floppy.yml";

const running = await boot({ configPath });
running.kernel.bus.on("plugin.state", (s) => parent.postMessage({ type: "plugin.state", ...s }));
parent.postMessage({ type: "kernel.ready", plugins: running.kernel.status() });

// ------------------------------------------------------------------ réglages (fenêtre des réglages ↔ registre du noyau)
const k = running.kernel;
/** Message d'une erreur dans la langue de l'interface (celui qui lit la fenêtre). */
const uiError = (err: unknown) => tr(errorText(err), k.uiLang);
const snapshot = () => ({ type: "settings", list: k.settings.list(), sections: k.sections.list(), plugins: k.status(), slots: k.slots(), lang: k.uiLang });
let pushTimer: NodeJS.Timeout | undefined;
const pushSoon = () => {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => parent.postMessage(snapshot()), 100);
};
k.settings.onChange(pushSoon);
k.sections.onChange(pushSoon);
k.bus.on("plugin.state", pushSoon);

// Éléments (catalogue) : modèles, voix, connecteurs, corps, avatars. Envoyés à chaque changement.
let itemsTimer: NodeJS.Timeout | undefined;
const pushItems = () => {
  clearTimeout(itemsTimer);
  itemsTimer = setTimeout(() => { void k.items.snapshot().then((providers) => parent.postMessage({ type: "items", providers, lang: k.uiLang })); }, 120);
};
k.items.onChange(pushItems);
k.items.onChange(pushSoon); // les options des réglages (voix, cerveau) suivent les éléments
k.settings.onChange(pushItems);
k.bus.on("plugin.state", pushItems);

parent.on("message", (e) => {
  const d = e.data as { type?: string; key?: string; value?: unknown; reqId?: number };
  if (d?.type === "settings.get") parent.postMessage(snapshot());
  if (d?.type === "settings.set") {
    void k.settings.change(String(d.key), d.value, "ui")
      .then((r) => parent.postMessage({ type: "settings.result", reqId: d.reqId, ok: r.ok, text: r.text }))
      .catch((err) => parent.postMessage({ type: "settings.result", reqId: d.reqId, ok: false, text: uiError(err) }));
  }
  if (d?.type === "settings.undo") {
    void k.settings.undo("ui")
      .then((r) => parent.postMessage({ type: "settings.result", reqId: d.reqId, ok: r.ok, text: r.text }))
      .catch((err) => parent.postMessage({ type: "settings.result", reqId: d.reqId, ok: false, text: uiError(err) }));
  }
  if (d?.type === "items.get") pushItems();
  if (d?.type === "items.op") {
    const op = (d as { op?: unknown }).op;
    void k.items.run(op as never, "ui")
      .then((r) => parent.postMessage({ type: "items.result", reqId: d.reqId, ...r }))
      .catch((err) => parent.postMessage({ type: "items.result", reqId: d.reqId, ok: false, text: uiError(err) }));
  }
  if (typeof d?.type === "string" && d.type.startsWith("coder.")) handleCoder(d as CoderMsg);
  if (d?.type === "stop") void running.stop().then(() => process.exit(0));
  if (d?.type === "status") parent.postMessage({ type: "status", plugins: running.kernel.status() });
});

// ------------------------------------------------------------------ assistant IA (service « coder » ↔ fenêtre des réglages)
interface CoderMsg { type: string; reqId?: number; agent?: string; mode?: string; sessionId?: string; text?: string; permissionId?: string; allow?: boolean }
// Le service peut être absent ou redémarré : on le relit à chaque message.
const coder = () => k.service<CoderService>("coder");
let coderUnsub: (() => void) | undefined;
let coderSub: CoderService | undefined;
function watchCoder() {
  const svc = coder();
  if (svc === coderSub) return;
  coderUnsub?.();
  coderUnsub = undefined;
  coderSub = svc;
  if (svc) coderUnsub = svc.onEvent((event) => parent.postMessage({ type: "coder.event", event }));
}
k.bus.on("plugin.state", (s: { id?: string }) => { if (s?.id === "coder") watchCoder(); });
watchCoder();

function handleCoder(d: CoderMsg) {
  watchCoder();
  const svc = coder();
  const reply = (ok: boolean, value?: unknown, error?: string) => parent.postMessage({ type: "coder.result", reqId: d.reqId, ok, value, error });
  const sid = String(d.sessionId ?? "");
  try {
    if (d.type === "coder.agents") {
      if (!svc) return reply(false, undefined, tr(T("assistant indisponible", "assistant unavailable"), k.uiLang));
      svc.agents().then((v) => reply(true, v), (err) => reply(false, undefined, uiError(err)));
    } else if (d.type === "coder.start") {
      if (!svc) return reply(false, undefined, tr(T("assistant indisponible", "assistant unavailable"), k.uiLang));
      svc.start({ agent: String(d.agent ?? ""), mode: d.mode === "plugin" ? "plugin" : "reglages" })
        .then((v) => reply(true, v), (err) => reply(false, undefined, uiError(err)));
    } else if (d.type === "coder.send") svc?.send(sid, String(d.text ?? ""));
    else if (d.type === "coder.cancel") svc?.cancel(sid);
    else if (d.type === "coder.permission") svc?.answerPermission(sid, String(d.permissionId), d.allow === true);
    else if (d.type === "coder.close") svc?.close(sid);
  } catch (err) {
    if (d.reqId !== undefined) reply(false, undefined, uiError(err));
  }
}
