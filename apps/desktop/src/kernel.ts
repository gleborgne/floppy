// Entrée du noyau dans l'app : tourne dans un utilityProcess d'Electron (Node 24 inclus dans Electron 45).
// Même démarrage que `floppy start` (boot.ts). Le plugin body-electron reçoit ici les MessagePort de l'avatar.
import { boot } from "@floppy/cli/boot";
import { T, tr, errorText, type HostChannel } from "@floppy/core";
import type { CoderService } from "@floppy/contracts";

interface ParentPort {
  on(ev: "message", fn: (e: { data: unknown }) => void): void;
  postMessage(data: unknown): void;
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
// Défaut : <répertoire de travail>/floppy.yml (boot.ts). FLOPPY_CONFIG impose une autre config.
const configPath = process.argv[2] ?? process.env.FLOPPY_CONFIG;

// Un démarrage impossible (floppy.yml invalide, plugin cassé au chargement) : la raison part à l'app avant l'arrêt,
// pour qu'elle la montre au lieu de relancer en boucle.
const running = await boot({ ...(configPath ? { configPath } : {}), host: parent as unknown as HostChannel }).catch((err: unknown) => {
  console.error(err);
  parent.postMessage({ type: "kernel.failed", text: errorText(err) });
  setTimeout(() => process.exit(2), 200);
  return new Promise<never>(() => {});
});
running.kernel.bus.on("plugin.state", (s) => parent.postMessage({ type: "plugin.state", ...s }));
// Nouveau répertoire de travail : l'app relance le noyau, qui repart dans ce dossier.
running.kernel.bus.on("floppy.restart", () => parent.postMessage({ type: "restart" }));
parent.postMessage({ type: "kernel.ready", plugins: running.kernel.status(), firstRun: running.firstRun });

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
  if (typeof d?.type === "string" && d.type.startsWith("onboarding.")) handleOnboarding(d as OnboardingMsg);
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
// Le fournisseur du service « coder » change (démarré, arrêté, remplacé) : on suit le nouveau, quel que soit son id.
k.bus.on("service.changed", (c) => { if (c.name === "coder") watchCoder(); });
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
      svc.start({ agent: String(d.agent ?? ""), mode: d.mode === "plugin" ? "plugin" : "settings" })
        .then((v) => reply(true, v), (err) => reply(false, undefined, uiError(err)));
    } else if (d.type === "coder.send") svc?.send(sid, String(d.text ?? ""));
    else if (d.type === "coder.cancel") svc?.cancel(sid);
    else if (d.type === "coder.permission") svc?.answerPermission(sid, String(d.permissionId), d.allow === true);
    else if (d.type === "coder.close") svc?.close(sid);
  } catch (err) {
    if (d.reqId !== undefined) reply(false, undefined, uiError(err));
  }
}

// ------------------------------------------------------------------ premier lancement (fenêtre « Bienvenue »)
interface OnboardingMsg { type: string; reqId?: number; fresh?: boolean; manualBytes?: number; level?: string; brain?: string; gpus?: unknown }
const ob = running.onboarding;
ob.onState((state) => parent.postMessage({ type: "onboarding.state", state }));

function handleOnboarding(d: OnboardingMsg) {
  const reply = (ok: boolean, value?: unknown, text?: unknown) => parent.postMessage({ type: "onboarding.result", reqId: d.reqId, ok, value, text });
  try {
    if (d.type === "onboarding.hint") {
      // Fabricants des puces vues par l'appli : utiles seulement si aucune sonde ne répond.
      const list = Array.isArray(d.gpus) ? d.gpus.slice(0, 8) : [];
      k.machineHint = list.map((g) => ({ vendorId: Number((g as { vendorId?: unknown }).vendorId) || 0, name: String((g as { name?: unknown }).name ?? "").slice(0, 120) }));
    } else if (d.type === "onboarding.get") {
      const manual = typeof d.manualBytes === "number" && d.manualBytes >= 0 ? d.manualBytes : undefined;
      ob.plan({ fresh: d.fresh === true, ...(manual !== undefined ? { manualBytes: manual } : {}) }).then(
        ({ candidates: _c, ...plan }) => reply(true, { ...plan, state: ob.state, lang: k.uiLang, home: k.home }),
        (err) => reply(false, undefined, uiError(err)),
      );
    } else if (d.type === "onboarding.apply") {
      const r = ob.apply(String(d.level ?? "") as never, d.brain ? { brain: String(d.brain) } : {});
      reply(r.ok, undefined, r.text);
    } else if (d.type === "onboarding.skip") {
      ob.skip();
      reply(true);
    }
  } catch (err) {
    reply(false, undefined, uiError(err));
  }
}
