// Réglages propres au noyau : rubriques « general » et « plugins », langues (interface, assistant), répertoire de
// travail, et la carte de fin d'un téléchargement. Posés par le constructeur du noyau.
import { chooseHome } from "../util/home.ts";
import { isLang, LANGS, T, tr } from "../i18n.ts";
import type { KernelInternals } from "./kernel-internals.ts";

export function declareCoreSettings(k: KernelInternals): void {
  // Rubriques propres au noyau : « general » (ses réglages) et « plugins » (la liste des plugins chargés). Les autres viennent des plugins.
  k.sections.declare("core", [
    { id: "general", order: 0, label: { fr: "Général", en: "General" }, description: { fr: "Langue et réglages de base. Tout se règle aussi à la voix : « Floppy, prends une voix de femme ».", en: "Language and basic settings. Everything can also be set by voice: “Floppy, use a female voice”." } },
    { id: "plugins", order: 60, view: "plugins", label: { fr: "Plugins", en: "Plugins" }, description: { fr: "Les plugins chargés par le noyau, et les réglages des plugins que tu as créés.", en: "Plugins loaded by the kernel, and settings of the plugins you created." } },
  ]);
  k.settings.declare("core", [{
    key: "ui_language", section: "general", group: { fr: "Langue", en: "Language" },
    label: { fr: "Langue de l'interface", en: "Interface language" },
    description: { fr: "Langue de la fenêtre des réglages et des menus.", en: "Language of the settings window and menus." },
    type: "enum", options: LANGS.map((l) => ({ value: l.value, label: l.label, aliases: [...l.aliases] })), risk: "free",
    get: () => k.uiLang,
    set: (v) => { k.uiLang = String(v); },
  }, {
    key: "assistant_language", section: "general", group: { fr: "Langue", en: "Language" },
    label: { fr: "Langue de l'assistant", en: "Assistant language" },
    description: {
      fr: "La langue dans laquelle Floppy écoute et parle. Changer de langue redémarre les plugins (quelques secondes).",
      en: "The language Floppy listens and speaks in. Changing it restarts the plugins (a few seconds).",
    },
    type: "enum", options: LANGS.map((l) => ({ value: l.value, label: l.label, aliases: [...l.aliases] })), risk: "free",
    get: () => k.assistant.language,
    set: (v) => {
      k.assistantLang = String(v);
      if (k.baseCfg) { const base = k.baseCfg; void k.enqueue(() => k.applyNow(base)).catch(() => {}); }
    },
  }]);
  // Répertoire de travail : config, réglages, modèles, espaces des agents, plugins tiers, journaux (voir util/home.ts).
  // Le changer relance le noyau ; les données suivent, sauf si le nouveau dossier a déjà des données de Floppy.
  k.settings.declare("core", [{
    key: "home_folder", section: "general", group: { fr: "Dossier de Floppy", en: "Floppy's folder" },
    label: { fr: "Répertoire de travail", en: "Working folder" },
    description: {
      fr: "Le dossier où Floppy garde tout : config, réglages, modèles, espaces de travail des agents, plugins, journaux. Le changer relance Floppy et y déplace ses données (un dossier qui a déjà des données de Floppy est repris tel quel).",
      en: "The folder where Floppy keeps everything: config, settings, models, agents' workspaces, plugins, logs. Changing it restarts Floppy and moves its data there (a folder that already holds Floppy data is used as is).",
    },
    type: "text", maxLength: 500, folder: true, risk: "cli",
    get: () => k.home,
    set: (v) => {
      const what = chooseHome(String(v ?? ""));
      if (what === "same") return;
      k.log("info", "core", `nouveau répertoire de travail (${what === "move" ? "données déplacées" : "données reprises"}) : ${String(v)}`);
      // La réponse part d'abord à la fenêtre ; ensuite l'hôte relance le noyau dans le nouveau dossier.
      setTimeout(() => k.bus.emit("floppy.restart", { reason: T("nouveau répertoire de travail", "new working folder") }), 300).unref?.();
    },
  }]);
  // Fin d'un téléchargement : une carte (sans voix) pour le dire, même si la fenêtre est fermée.
  k.downloads.onChange((d) => {
    if (d.state !== "done" && d.state !== "error") return;
    const name = tr(d.label, k.uiLang);
    const text = d.state === "done"
      ? tr({ fr: `${name} est téléchargé.`, en: `${name} is downloaded.` }, k.uiLang)
      : `${name} : ${tr(d.error, k.uiLang)}`;
    k.bus.emit("initiative", { source: "downloads", text, importance: "normal", key: `download:${d.key}` });
  });
  {
    const saved = k.settings.savedValue<string>("assistant_language");
    if (saved && isLang(saved)) k.assistantLang = saved;
  }
}
