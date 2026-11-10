// Plugin `body-electron` : branche le corps par défaut (avatar de l'app Electron) sur le hub.
// Le noyau tourne dans un utilityProcess ; le processus principal lui passe un MessagePort par fenêtre d'avatar
// (un nouveau port à chaque rechargement de la fenêtre). Hors de l'app (floppy start --headless) : le plugin reste
// inactif (état « avertissement », pas une erreur) ; le registre d'avatars existe quand même, sans affichage.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { definePlugin, fold, T, TextError, tr, type ItemInfo, type Text } from "@floppy/core";
import type { AvatarEntry } from "@floppy/contracts";
import { registerDesktop } from "@floppy/toolkit";
import { findSettingsTarget, type FoundTarget } from "./settings-target.ts";
import { normalizeShortcut, SHORTCUT_DEFAULTS, SHORTCUT_LABELS, SHORTCUT_SETTING_KEY, type ShortcutAction } from "./shortcuts.ts";
import type { BodyToKernel, BodyTransport, KernelToBody } from "@floppy/protocol";

/** Port de message d'Electron côté utilityProcess (MessagePortMain). */
interface PortMain {
  on(ev: "message", fn: (e: { data: unknown }) => void): void;
  on(ev: "close", fn: () => void): void;
  postMessage(data: unknown): void;
  start(): void;
  close(): void;
}

interface ParentPort {
  on(ev: "message", fn: (e: { data: unknown; ports: PortMain[] }) => void): void;
  off?(ev: "message", fn: (e: { data: unknown; ports: PortMain[] }) => void): void;
  removeListener?(ev: "message", fn: (e: { data: unknown; ports: PortMain[] }) => void): void;
  postMessage(data: unknown): void;
}

/**
 * L'audio du micro peut arriver comme Float32Array, ArrayBuffer, ou octets (Uint8Array / Buffer) selon la
 * sérialisation d'Electron. On relit toujours les OCTETS comme des float32 (jamais une conversion élément par élément).
 */
export function toFloat32(a: unknown): Float32Array {
  if (a instanceof Float32Array) return a;
  if (a instanceof ArrayBuffer) return new Float32Array(a);
  if (ArrayBuffer.isView(a)) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 4));
    copy.set(bytes.subarray(0, copy.byteLength));
    return new Float32Array(copy.buffer);
  }
  return new Float32Array(0);
}

/** Messages sur le port : { j: <json du protocole> } ou { a: <audio> }. */
export function portTransport(port: PortMain): BodyTransport {
  let seen = false;
  const onMsg: ((m: BodyToKernel) => void)[] = [];
  const onAudio: ((f: Float32Array) => void)[] = [];
  const onClose: (() => void)[] = [];
  port.on("message", (e) => {
    const d = e.data as { j?: BodyToKernel; a?: Float32Array | ArrayBuffer };
    if (d?.j) for (const fn of onMsg) fn(d.j);
    else if (d?.a) {
      const f = toFloat32(d.a);
      if (!seen) { seen = true; console.log(`[bodyel] 1re trame audio : ${Object.prototype.toString.call(d.a)} ${(d.a as ArrayBufferView).byteLength ?? (d.a as ArrayBuffer).byteLength} octets → ${f.length} échantillons`); }
      for (const fn of onAudio) fn(f);
    }
  });
  port.on("close", () => { for (const fn of onClose) fn(); });
  port.start();
  return {
    send: (m: KernelToBody) => port.postMessage({ j: m }),
    sendAudio: (data) => port.postMessage({ a: data }),
    onMessage: (fn) => { onMsg.push(fn); },
    onAudio: (fn) => { onAudio.push(fn); },
    onClose: (fn) => { onClose.push(fn); },
    close: () => port.close(),
  };
}

/** Réglages d'affichage de l'avatar (appliqués par le processus principal de l'app). */
export interface DisplaySettings {
  avatar_visible: boolean;
  hide_after: number;
  bubble: boolean;
  always_on_top: boolean;
  /** Lancer Floppy à l'ouverture de la session (réglage `demarrage_windows`). */
  autostart: boolean;
  /** Avatar affiché (id d'un plugin plugins/avatar/<id>/) et adresse file:// de son dessin. */
  avatar: string;
  avatarUrl: string;
  /** Raccourcis clavier globaux (« Ctrl+Alt+F » ; vide = désactivé), appliqués par le processus principal. */
  shortcuts: Record<ShortcutAction, string>;
}

export { normalizeShortcut, SHORTCUT_DEFAULTS, type ShortcutAction } from "./shortcuts.ts";
export { type AvatarInfo, type AvatarEntry, type AvatarRegistry } from "@floppy/contracts";
export { defineAvatar, readAvatarDir } from "@floppy/toolkit";

const Config = z.object({
  /** Avatar affiché au départ si l'utilisateur n'en a pas choisi (id). Absent : le premier par id. */
  avatar: z.string().optional(),
});
type Config = z.infer<typeof Config>;

export default definePlugin<Config>({
  manifest: {
    id: "body-electron",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "corps", label: { fr: "Corps et affichage", en: "Bodies and display" } },
      { id: "systeme", order: 80, label: { fr: "Système", en: "System" }, description: { fr: "Démarrage et comportement de l'application.", en: "Startup and behaviour of the application." } },
    ],
    description: "Transport MessagePort : l'avatar de l'app Electron.",
    inject: ["body"],
    // Registre des avatars : les plugins de plugins/avatar/<id>/ s'y inscrivent.
    provides: ["avatars"],
  },
  config: Config,
  apply(ctx, cfg) {
    // Canal vers l'app de bureau, donné par l'hôte (boot({ host })) : jamais un objet global du processus.
    const parent = ctx.host as ParentPort | undefined;
    if (!parent) {
      // Hors de l'app (--headless) : pas d'écran, donc pas de corps. Ce n'est pas une panne : on reste inactif.
      ctx.items.status({ fr: "inactif : pas dans l'application (mode --headless)", en: "inactive: not running inside the app (--headless mode)" }, "warn");
      const none = new Map<string, AvatarEntry>();
      ctx.provide("avatars", {
        register: (a) => { none.set(a.id, a); return () => { if (none.get(a.id) === a) none.delete(a.id); }; },
        list: () => [...none.values()],
      });
      return;
    }
    registerDesktop(ctx, { id: "settings", title: { fr: "Réglages", en: "Settings" }, menus: ["avatar"], order: 10 }, {
      actions: { open: async (signal) => { const result = await openWindow({ signal }, "", undefined); if (result.status !== "done") throw new TextError(result.text); return { ok: true }; } },
    });
    const hub = ctx.get("body");
    ctx.hook("conversation.command", async (input, next) => {
      const text = fold(input.text).replace(/[’]/g, "'").trim();
      const opening = /^(?:(?:tu peux|peux-tu|pourrais-tu) )?(?:m'|me )?(?:ouvre|ouvrir|affiche|afficher)(?:[- ]moi)? (?:l'ecran (?:de |des |de tes )|la fenetre (?:de |des |de tes ))?(?:(?:les|tes|des) )?(?:reglages|parametres)(?: de floppy)?(?:,? s'il te plait)?[.!? ]*$/;
      // En anglais : « open the settings », « can you show me Floppy's settings please ».
      const openingEn = /^(?:(?:can you|could you|please) )?(?:open|show)(?: me)? (?:the |your |floppy'?s? )?(?:settings|preferences|options)(?: window| screen)?(?: of floppy)?(?:,? please)?[.!? ]*$/;
      if (opening.test(text) || openingEn.test(text)) return { name: "ouvrir_reglages", args: {} };
      return next(input);
    });
    const pendingOpen = new Map<string, (ok: boolean, text?: Text) => void>();
    const onSettingsResult = (e: { data: unknown }) => {
      const m = e.data as { type?: string; reqId?: string; ok?: boolean; text?: string };
      if (m?.type === "settings.open.result" && m.reqId) pendingOpen.get(m.reqId)?.(m.ok === true, m.text);
    };
    parent.on("message", onSettingsResult);
    ctx.tools.register([{
      name: "ouvrir_reglages",
      description: "Ouvre et affiche à l'écran la fenêtre des réglages de Floppy. Appelle cet outil quand l'utilisateur demande d'ouvrir les réglages ou les paramètres de Floppy. "
        + "Avec `element`, ouvre directement la page de cet élément (un connecteur, une voix, un modèle…). "
        + "Une action qui se fait par un bouton des réglages (installer le plugin Orca, se connecter à Microsoft 365, envoyer un mail de test…) ne se fait pas à la voix : "
        + "ouvre les réglages sur l'élément concerné et dis à l'utilisateur sur quel bouton cliquer.",
      inputSchema: {
        type: "object",
        properties: { element: { type: "string", description: "Nom de l'élément tel qu'entendu (ex. « Orca », « Microsoft 365 »). Facultatif." } },
        additionalProperties: false,
      },
      level: "read",
      handler: async (args, meta) => {
        const heard = typeof (args as { element?: unknown }).element === "string" ? (args as { element: string }).element.trim().slice(0, 100) : "";
        let found: FoundTarget | undefined;
        if (heard) { try { found = findSettingsTarget(await ctx.items.snapshot(), heard); } catch { /* réglages ouverts sans page précise */ } }
        return openWindow(meta, heard, found);
      },
    }]);
    const openWindow = (meta: { signal?: AbortSignal }, heard: string, found: FoundTarget | undefined) => new Promise<{ status: "done" | "failed"; text: Text }>((resolve) => {
        const reqId = randomUUID();
        const shown = (): Text => {
          if (!heard) return T("La fenêtre des réglages est affichée.", "The settings window is shown.");
          if (!found) return T(`La fenêtre des réglages est affichée. Je n'ai pas trouvé « ${heard} » dans les réglages.`, `The settings window is shown. I did not find "${heard}" in the settings.`);
          const name = (l: "fr" | "en") => tr(found.label, l);
          const btn = (l: "fr" | "en") => found.actions.map((a) => `« ${tr(a, l)} »`).join(", ");
          return found.actions.length
            ? T(`Les réglages sont ouverts sur ${name("fr")}. Boutons : ${btn("fr")}.`, `Settings are open on ${name("en")}. Buttons: ${btn("en")}.`)
            : T(`Les réglages sont ouverts sur ${name("fr")}.`, `Settings are open on ${name("en")}.`);
        };
        const finish = (ok: boolean, text?: Text) => {
          if (!pendingOpen.delete(reqId)) return;
          clearTimeout(timer);
          meta.signal?.removeEventListener("abort", abort);
          resolve({ status: ok ? "done" : "failed", text: text ?? (ok ? shown() : T("La fenêtre des réglages n'a pas pu être affichée.", "The settings window could not be shown.")) });
        };
        const abort = () => finish(false, T("Ouverture annulée.", "Opening cancelled."));
        const timer = setTimeout(() => finish(false, T("L'application n'a pas confirmé l'ouverture des réglages.", "The app did not confirm that the settings opened.")), 10_000);
        pendingOpen.set(reqId, finish);
        meta.signal?.addEventListener("abort", abort, { once: true });
        if (meta.signal?.aborted) return abort();
        try { parent.postMessage({ type: "settings.open", reqId, ...(found ? { target: found.target } : {}) }); }
        catch { finish(false, T("L'application ne répond pas.", "The app does not answer.")); }
      });
    ctx.effect(() => {
      (parent.off ?? parent.removeListener)?.call(parent, "message", onSettingsResult);
      for (const finish of pendingOpen.values()) finish(false, T("Plugin arrêté.", "Plugin stopped."));
    });
    // Réglages d'affichage : gardés ici, appliqués par le processus principal (message "display").
    const display: DisplaySettings = {
      avatar_visible: ctx.settings.saved<boolean>("avatar_visible") ?? true,
      hide_after: ctx.settings.saved<number>("masquer_apres") ?? 0,
      bubble: ctx.settings.saved<boolean>("bulle") ?? true,
      always_on_top: ctx.settings.saved<boolean>("toujours_devant") ?? true,
      autostart: ctx.settings.saved<boolean>("demarrage_windows") ?? false,
      avatar: "",
      avatarUrl: "",
      shortcuts: Object.fromEntries((Object.keys(SHORTCUT_DEFAULTS) as ShortcutAction[]).map((a) => {
        const saved = ctx.settings.saved<string>(SHORTCUT_SETTING_KEY[a]);
        let v = SHORTCUT_DEFAULTS[a];
        if (typeof saved === "string") { try { v = normalizeShortcut(saved); } catch { /* valeur gardée illisible : défaut */ } }
        return [a, v];
      })) as Record<ShortcutAction, string>,
    };
    // Avatars : inscrits par les plugins d'avatar ; le choix et les désactivés sont gardés dans <home>/items/avatars.json.
    const store = ctx.items.store("avatars");
    const avatars = new Map<string, AvatarEntry>();
    const pick = (): void => {
      const cur = store.data.extra.current;
      const ok = (id: unknown) => typeof id === "string" && avatars.has(id) && store.isEnabled(id);
      // Choix de l'utilisateur, sinon celui de la config, sinon le premier avatar actif (par id) : aucun n'est codé en dur.
      const first = [...avatars.keys()].sort().find(ok);
      display.avatar = ok(cur) ? String(cur) : ok(cfg.avatar) ? String(cfg.avatar) : first ?? "";
      display.avatarUrl = avatars.get(display.avatar)?.url ?? "";
    };
    ctx.provide("avatars", {
      register: (a) => {
        avatars.set(a.id, a);
        pick(); pushDisplay(); ctx.items.changed();
        return () => { if (avatars.get(a.id) === a) { avatars.delete(a.id); pick(); pushDisplay(); ctx.items.changed(); } };
      },
      list: () => [...avatars.values()],
    });
    const readAvatars = () => [...avatars.values()];
    const pushDisplay = () => parent.postMessage({ type: "display", settings: { ...display } });
    const GROUP: Text = { fr: "Affichage", en: "Display" };
    // `key` : clé du réglage (encore française, voir le lot des réglages) ; `field` : champ du message `display`.
    const bool = (key: string, field: "avatar_visible" | "bubble" | "always_on_top" | "autostart", label: Text, description: Text) => ({
      key, label, description, type: "boolean" as const, group: GROUP, section: "corps", risk: "free" as const,
      get: () => display[field],
      set: (v: unknown) => { display[field] = v === true || v === "true"; pushDisplay(); },
    });
    ctx.settings.declare([
      bool("avatar_visible", "avatar_visible", { fr: "Avatar visible", en: "Avatar visible" },
        { fr: "Montre ou cache l'avatar à l'écran. Il revient quand on lui parle.", en: "Shows or hides the avatar on screen. It comes back when you talk to it." }),
      {
        key: "masquer_apres", label: { fr: "Masquer après", en: "Hide after" }, type: "number", min: 0, max: 120, group: GROUP, section: "corps", risk: "free",
        description: { fr: "Minutes d'inactivité avant de cacher l'avatar (0 = jamais).", en: "Minutes of inactivity before hiding the avatar (0 = never)." },
        get: () => display.hide_after,
        set: (v) => { display.hide_after = Math.max(0, Math.min(120, Math.round(Number(v)))); pushDisplay(); },
      },
      bool("bulle", "bubble", { fr: "Bulle de texte", en: "Text bubble" },
        { fr: "Affiche la bulle avec ce qui est dit au-dessus de l'avatar.", en: "Shows the bubble with what is said above the avatar." }),
      bool("toujours_devant", "always_on_top", { fr: "Toujours devant", en: "Always on top" },
        { fr: "Garde l'avatar au-dessus des autres fenêtres.", en: "Keeps the avatar above other windows." }),
      {
        ...bool("demarrage_windows", "autostart", { fr: "Démarrer avec l'ordinateur", en: "Start with the computer" },
          { fr: "Lance Floppy à l'ouverture de ta session.", en: "Starts Floppy when you sign in." }),
        group: { fr: "Système", en: "System" } as Text, section: "systeme",
      },
      // Raccourcis clavier : un réglage par action, dans Réglages → Système. Vide = raccourci désactivé.
      ...(Object.keys(SHORTCUT_DEFAULTS) as ShortcutAction[]).map((a) => ({
        key: SHORTCUT_SETTING_KEY[a], label: SHORTCUT_LABELS[a].label,
        description: { fr: `${tr(SHORTCUT_LABELS[a].description, "fr")} Par défaut : ${SHORTCUT_DEFAULTS[a]}. Vide : désactivé.`, en: `${tr(SHORTCUT_LABELS[a].description, "en")} Default: ${SHORTCUT_DEFAULTS[a]}. Empty: off.` } as Text,
        type: "text" as const, min: 0, maxLength: 40, section: "systeme", group: { fr: "Raccourcis clavier", en: "Keyboard shortcuts" } as Text, risk: "free" as const,
        presets: [{ value: SHORTCUT_DEFAULTS[a], label: { fr: `${SHORTCUT_DEFAULTS[a]} (par défaut)`, en: `${SHORTCUT_DEFAULTS[a]} (default)` } }],
        get: () => display.shortcuts[a],
        set: (v: unknown) => {
          const next = normalizeShortcut(v);
          const taken = next ? (Object.keys(display.shortcuts) as ShortcutAction[]).find((o) => o !== a && display.shortcuts[o].toLowerCase() === next.toLowerCase()) : undefined;
          if (taken) throw new TextError(T(`${next} sert déjà à « ${tr(SHORTCUT_LABELS[taken].label, "fr")} ».`, `${next} is already used for “${tr(SHORTCUT_LABELS[taken].label, "en")}”.`));
          display.shortcuts = { ...display.shortcuts, [a]: next };
          pushDisplay();
        },
      })),
    ]);
    ctx.items.declare({
      id: "avatars", section: "corps", layout: "grid", order: 10,
      label: { fr: "Avatars", en: "Avatars" },
      description: { fr: "Les avatars sont des plugins : mêmes états et émotions envoyés par le noyau.", en: "Avatars are plugins: same states and emotions sent by the kernel." },
      list: () => readAvatars().map((a): ItemInfo => {
        const active = a.id === display.avatar;
        return {
          id: a.id, label: a.name, detail: a.description, ...(a.preview ? { preview: a.preview } : {}),
          enabled: store.isEnabled(a.id) || active, active,
          tags: [T(`${a.emotions.length} émotions`, `${a.emotions.length} emotions`)],
          status: active ? "ok" : "off",
          ...(active ? { statusText: { fr: "utilisé", en: "in use" } } : {}),
          editable: false, removable: false, toggleable: !active,
          // voice : « mets l'avatar chat » (outil utiliser_element) ; changer d'avatar est sans risque.
          actions: active ? [] : [{ id: "use", label: { fr: "Utiliser", en: "Use" }, voice: true }],
          aliases: [a.id],
        };
      }),
      setEnabled: async (id, on) => {
        if (!readAvatars().some((a) => a.id === id)) return { ok: false, text: T("Avatar inconnu.", "Unknown avatar.") };
        if (!on && id === display.avatar) return { ok: false, text: T("C'est l'avatar affiché : choisis-en un autre d'abord.", "This is the avatar on screen: choose another one first.") };
        store.setEnabled(id, on);
        return { ok: true, text: on ? T("Avatar activé.", "Avatar enabled.") : T("Avatar désactivé (gardé dans la liste).", "Avatar disabled (kept in the list).") };
      },
      action: async (id, action) => {
        if (action !== "use") return { ok: false, text: T("Action inconnue.", "Unknown action.") };
        if (!readAvatars().some((x) => x.id === id)) return { ok: false, text: T("Avatar inconnu.", "Unknown avatar.") };
        store.setEnabled(id, true);
        store.data.extra.current = id;
        store.save();
        display.avatar = id;
        display.avatarUrl = avatars.get(id)?.url ?? "";
        pushDisplay();
        return { ok: true, text: T("Avatar changé.", "Avatar changed."), id };
      },
    });
    pushDisplay();
    const ports = new Set<PortMain>();
    const onMessage = (e: { data: unknown; ports: PortMain[] }) => {
      if ((e.data as { type?: string })?.type !== "body-port" || !e.ports[0]) return;
      const port = e.ports[0];
      ports.add(port);
      port.on("close", () => ports.delete(port));
      // Corps de l'app : identité fixée ici, pas par le hello du renderer.
      hub.attach(portTransport(port), { id: "avatar", name: "Avatar (bureau)", managed: false });
    };
    parent.on("message", onMessage);
    // Demande un port au processus principal (utile après un redémarrage de ce plugin).
    parent.postMessage({ type: "need-body-port" });
    ctx.effect(() => {
      (parent.off ?? parent.removeListener)?.call(parent, "message", onMessage);
      for (const p of ports) p.close();
    });
  },
});
