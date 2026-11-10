// Commandes vocales de l'app : parler (push-to-talk), dormir (muet), et les raccourcis globaux qui les déclenchent.
// Propriétaire de l'état « parler » / « dort » et des raccourcis réellement posés.
import { app, globalShortcut } from "electron";
import { keysForOS, TEXTS } from "./main-texts.ts";
import { SHORTCUT_DEFAULTS } from "./app-texts.ts";
import type { Say } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { Dictation } from "./dictation.ts";
import type { ChatWindow } from "./chat-window.ts";

export interface VoiceControlsDeps {
  texts: Texts;
  /** Journal du noyau (kernel.log). */
  kernelLog: { write(chunk: string | Buffer): void };
  /** Problèmes montrés dans l'icône (propriétaire : l'icône). */
  problems: Pick<Map<string, Say>, "set" | "delete">;
  refreshTray(): void;
  avatar(): Pick<AvatarWindow, "win" | "activity" | "toggleWindow">;
  dictation(): Pick<Dictation, "toggleDictate">;
  chat(): Pick<ChatWindow, "open">;
}

export interface VoiceControls {
  pttOn(): boolean;
  muted(): boolean;
  setMuted(muted: boolean): void;
  togglePtt(): void;
  toggleMute(): void;
  /** Le corps change d'état : hors écoute, « parler » est fini. */
  stateChanged(s: string): void;
  applyShortcuts(next: unknown): void;
}

export function createVoiceControls(deps: VoiceControlsDeps): VoiceControls {
  const { kernelLog, problems, texts } = deps;
  const shortcuts = texts.shortcuts;
  const refreshTray = () => deps.refreshTray();
  const activity = () => deps.avatar().activity();
  let pttOn = false;
  let muted = false;

  function togglePtt() { activity(); pttOn = !pttOn; deps.avatar().win()?.webContents.send("shortcut", pttOn ? "ptt-on" : "ptt-off"); refreshTray(); }
  function toggleMute() { muted = !muted; deps.avatar().win()?.webContents.send("shortcut", muted ? "mute-on" : "mute-off"); refreshTray(); }

  const SHORTCUT_ACTIONS: Record<string, () => void> = { write: () => { deps.chat().open(); }, talk: () => togglePtt(), dictate: () => deps.dictation().toggleDictate(), sleep: () => toggleMute(), avatar: () => deps.avatar().toggleWindow() };
  const registered = new Map<string, string>(); // action -> raccourci posé
  /** Pose les raccourcis globaux choisis. Un raccourci déjà pris par une autre app (ex. Ctrl+Alt+Espace) est signalé. */
  function applyShortcuts(next: unknown): void {
    if (!app.isReady()) return;
    for (const [a, fn] of Object.entries(SHORTCUT_ACTIONS)) {
      const chosen = (next as Record<string, unknown> | null | undefined)?.[a];
      const keys = typeof chosen === "string" ? chosen : SHORTCUT_DEFAULTS[a]!;
      shortcuts[a] = keys;
      if (registered.get(a) === keys) continue;
      const old = registered.get(a);
      if (old) { try { globalShortcut.unregister(old); } catch { /* déjà retiré */ } }
      registered.delete(a);
      problems.delete(`shortcut_${a}`);
      if (!keys) continue;
      let ok = false;
      try { ok = globalShortcut.register(keys, fn); } catch { ok = false; }
      kernelLog.write(`[app] raccourci ${keys} (${a}) : ${ok ? "ok" : "DÉJÀ PRIS par une autre app"}\n`);
      if (ok) registered.set(a, keys);
      else problems.set(`shortcut_${a}`, { fr: `${keysForOS(keys)} ${TEXTS.fr.taken}`, en: `${keysForOS(keys)} ${TEXTS.en.taken}` });
    }
    refreshTray();
  }

  return {
    pttOn: () => pttOn, muted: () => muted, setMuted: (m) => { muted = m; },
    togglePtt, toggleMute,
    stateChanged: (s) => { if (s !== "listening") pttOn = pttOn && s === "listening"; },
    applyShortcuts,
  };
}
