// Messages venus du noyau : réglages, éléments, premier lancement, assistant IA, état des plugins, affichage.
// Propriétaire des derniers états reçus (réglages, éléments, installation de départ) que les fenêtres relisent à l'ouverture.
import { app, shell, clipboard } from "electron";
import type { UtilityProcess } from "electron";
import { existsSync } from "node:fs";
import { TEXTS } from "./main-texts.ts";
import type { Lang } from "./main-texts.ts";
import type { Bilingual } from "./placement.ts";
import type { Msg, Say } from "./app-types.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { AppWindows } from "./app-windows.ts";
import type { createDesktopContributions } from "./desktop-contributions.ts";

// Logos { program } / { handler } des éléments (packages/core/src/logo.ts) : le noyau ne lit pas les icônes du système,
// l'app les lit ici et les remplace par une adresse data: avant d'envoyer la liste à la fenêtre. Clé → adresse, "" (rien) ou attente.
const logoCache = new Map<string, string | Promise<void>>();
function logoKey(l: unknown): string | null {
  if (!l || typeof l !== "object") return null;
  const { program, handler } = l as { program?: unknown; handler?: unknown };
  if (typeof program === "string") return `p:${program}`;
  if (typeof handler === "string") return `h:${handler}`;
  return null;
}
async function systemLogo(key: string): Promise<string> {
  try {
    if (key.startsWith("p:")) {
      const file = key.slice(2);
      if (!existsSync(file)) return "";
      const img = await app.getFileIcon(file, { size: process.platform === "darwin" ? "normal" : "large" });
      return img.isEmpty() ? "" : img.toDataURL();
    }
    // Programme qui ouvre ce protocole (« https » : le navigateur par défaut). Pas de cette lecture sous Linux.
    if (process.platform === "linux") return "";
    const info = await app.getApplicationInfoForProtocol(`${key.slice(2)}://`);
    return info?.icon && !info.icon.isEmpty() ? info.icon.toDataURL() : "";
  } catch { return ""; }
}

export interface KernelMessagesDeps {
  texts: Texts;
  /** Problèmes montrés dans l'icône (propriétaire : l'icône). */
  problems: Pick<Map<string, Say>, "set" | "delete">;
  contributions: Pick<ReturnType<typeof createDesktopContributions>, "message" | "state" | "reconcile">;
  kernel(): Pick<KernelProcess, "kernel" | "restart" | "bodyPortRequested" | "setBootFailure" | "pending">;
  avatar(): Pick<AvatarWindow, "applyDisplay">;
  windows(): Pick<AppWindows, "settingsWin" | "onbWin" | "openOnboarding" | "showSettingsConfirmed" | "setLang">;
  refreshTray(): void;
}

export interface KernelMessages {
  /** Un message du noyau (déjà filtré : app pas en fermeture, `source` est bien le noyau courant). */
  handle(m: Msg, source: UtilityProcess): void;
  /** Dernier { list, sections, plugins, slots, lang } reçu du noyau. */
  lastSettings(): Msg | null;
  /** Dernier état de l'installation de départ (fenêtre « Bienvenue » et réglages). */
  lastOnb(): unknown;
  hasItems(): boolean;
  itemsPayload(): { providers: Msg[]; lang: Lang };
}

export function createKernelMessages(deps: KernelMessagesDeps): KernelMessages {
  const { texts, problems, contributions } = deps;
  const { waitText } = texts;
  const kernel = () => deps.kernel().kernel();
  const pending = deps.kernel().pending;
  const settingsWin = () => deps.windows().settingsWin();
  let lastSettings: Msg | null = null;        // dernier { list, sections, plugins, lang } reçu du noyau
  let lastOnb: unknown = null;            // dernier état de l'installation de départ (fenêtre « Bienvenue » et réglages)
  let lastItems: { providers: Msg[]; lang: Lang } | null = null;           // derniers { providers, lang } reçus du noyau (éléments : modèles, voix, connecteurs, corps, avatars)

  /** La liste des éléments pour la fenêtre : logos du système remplacés par leur image (lue une fois, puis gardée). */
  function itemsPayload() {
    const providers = (lastItems?.providers ?? []).map((p) => ({ ...p, items: ((p.items ?? []) as Msg[]).map((it) => {
      const key = logoKey(it.logo);
      if (!key) return it;
      const { logo: _, ...rest } = it;
      const v = logoCache.get(key);
      if (typeof v === "string") return v ? { ...rest, logo: v } : rest;
      if (!v) logoCache.set(key, systemLogo(key).then((d) => { logoCache.set(key, d); sendItems(); }));
      return rest;
    }) }));
    return { providers, lang: lastItems?.lang ?? texts.lang() };
  }
  function sendItems() { if (lastItems) settingsWin()?.webContents.send("items:update", itemsPayload()); }

  function handle(m: Msg, source: UtilityProcess): void {
    if (m?.type === "need-body-port") deps.kernel().bodyPortRequested();
    else if (m?.type === "kernel.failed") deps.kernel().setBootFailure(m.text ?? null);
    else if (m?.type === "restart") deps.kernel().restart();
    else if (m?.type === "display") deps.avatar().applyDisplay(m.settings);
    else if (typeof m?.type === "string" && m.type.startsWith("desktop.")) contributions.message(m);
    else if (m?.type === "settings.open") {
      const source = kernel();
      // Page demandée (« ouvre les réglages d'Orca ») : rubrique + élément, des textes courts seulement.
      const t = m.target;
      const ok = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
      const target = t && ok(t.section) && ok(t.provider) && ok(t.id) ? { section: t.section, provider: t.provider, id: t.id } : null;
      void deps.windows().showSettingsConfirmed().then(
        () => {
          if (target) settingsWin()?.webContents.send("settings:focus", target);
          source?.postMessage({ type: "settings.open.result", reqId: m.reqId, ok: true });
        },
        (error: unknown) => {
          const e = error as { text?: Bilingual; message?: unknown };
          // Texte { fr, en } : le noyau le dit dans la langue de l'assistant.
          const why = e?.text ?? { fr: String(e?.message ?? error), en: String(e?.message ?? error) };
          const text = { fr: `${TEXTS.fr.settingsNotOpened} : ${why.fr}`, en: `${TEXTS.en.settingsNotOpened}: ${why.en}` };
          source?.postMessage({ type: "settings.open.result", reqId: m.reqId, ok: false, text });
        },
      );
    }
    else if (m?.type === "clipboard.read") {
      // Lecture du texte du presse-papiers pour l'outil `read_clipboard` : le contenu n'est jamais journalisé ici.
      // Borné à 20 000 caractères (le plugin garde moins) ; `length` dit la taille réelle.
      // `readText` rend une promesse dans cette version d'Electron : on attend sans présumer.
      void (async () => {
        let text = "";
        try { text = String(await clipboard.readText()); } catch { /* presse-papiers illisible : traité comme vide */ }
        kernel()?.postMessage({ type: "clipboard.read.result", reqId: m.reqId, ok: true, text: text.slice(0, 20_000), length: text.length });
      })();
    }
    else if (m?.type === "settings") { deps.windows().setLang(m.lang); lastSettings = { list: m.list, sections: m.sections ?? [], plugins: m.plugins, slots: m.slots ?? [], lang: texts.lang() }; settingsWin()?.webContents.send("settings:update", lastSettings); }
    else if (m?.type === "items") { deps.windows().setLang(m.lang); lastItems = { providers: m.providers, lang: texts.lang() }; sendItems(); }
    else if (m?.type === "items.result") {
      // Opération lancée par un clic dans la fenêtre des réglages : on peut ouvrir une page (http(s)) et copier un code.
      if (m.ok && typeof m.copy === "string" && m.copy.length < 200) clipboard.writeText(m.copy);
      if (m.ok && typeof m.open === "string") { try { const u = new URL(m.open); if (u.protocol === "https:" || u.protocol === "http:") void shell.openExternal(u.toString()); } catch { /* adresse invalide */ } }
      // audio : le son d'un essai ou de « Écouter » (adresse data:audio/…), joué par la fenêtre.
      const audio = typeof m.audio === "string" && m.audio.startsWith("data:audio/") ? m.audio : undefined;
      pending.get(m.reqId)?.({ ok: m.ok, text: m.text, id: m.id, children: m.children, ...(audio ? { audio } : {}) });
      pending.delete(m.reqId);
    }
    else if (m?.type === "coder.event") settingsWin()?.webContents.send("coder:event", m.event);
    else if (m?.type === "coder.result") { pending.get(m.reqId)?.(m); pending.delete(m.reqId); }
    else if (m?.type === "onboarding.state") {
      lastOnb = m.state;
      const onbWin = deps.windows().onbWin();
      if (onbWin && !onbWin.isDestroyed()) onbWin.webContents.send("onboarding:state", m.state);
      const settingsWin = deps.windows().settingsWin();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("onboarding:state", m.state);
    }
    else if (m?.type === "onboarding.result") { pending.get(m.reqId)?.({ ok: m.ok, value: m.value, text: m.text }); pending.delete(m.reqId); }
    else if (m?.type === "settings.result") { pending.get(m.reqId)?.({ ok: m.ok, text: m.text }); pending.delete(m.reqId); }
    else if (m?.type === "plugin.state") {
      contributions.state(m.id, m.state);
      if (m.state === "error" || m.state === "waiting") problems.set(m.id, m.error ?? waitText(m.missing));
      else problems.delete(m.id);
      deps.refreshTray();
    } else if (m?.type === "kernel.ready") {
      contributions.reconcile(m.plugins.filter((p: Msg) => p.state === "active").map((p: Msg) => p.id));
      deps.kernel().setBootFailure(null);
      problems.delete("kernel");
      for (const p of m.plugins) if (p.state === "error" || p.state === "waiting") problems.set(p.id, p.error ?? waitText(p.missing));
      deps.refreshTray();
      // Fabricants des puces vues par l'appli : un indice pour la lecture de la machine, si aucune sonde ne répond.
      void app.getGPUInfo("basic").then((info) => {
        const gpus = ((info as { gpuDevice?: { vendorId: number; deviceString?: string }[] } | null)?.gpuDevice ?? []).map((g) => ({ vendorId: g.vendorId, name: g.deviceString ?? "" }));
        source.postMessage({ type: "onboarding.hint", gpus });
      }).catch(() => {}).finally(() => { if (m.firstRun) deps.windows().openOnboarding(); });
    }
  }

  return { handle, lastSettings: () => lastSettings, lastOnb: () => lastOnb, hasItems: () => !!lastItems, itemsPayload };
}
