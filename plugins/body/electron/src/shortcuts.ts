// Raccourcis clavier globaux de l'app de bureau : réglables dans Réglages → Système → Raccourcis clavier.
// Valeur gardée : la forme lisible « Ctrl+Alt+F » (acceptée telle quelle par Electron). Vide = raccourci désactivé.
import { T, TextError, type Text } from "@floppy/core";

export type ShortcutAction = "talk" | "write" | "dictate" | "sleep" | "avatar";

/**
 * Frontière avec les réglages : les clés `raccourci_<action>` restent françaises jusqu'au lot des réglages ;
 * le message `display` (et tout le reste du code) parle déjà des actions en anglais.
 */
export const SHORTCUT_SETTING_KEY: Record<ShortcutAction, string> = {
  talk: "raccourci_parler", write: "raccourci_ecrire", dictate: "raccourci_dicter", sleep: "raccourci_dormir", avatar: "raccourci_avatar",
};

export const SHORTCUT_DEFAULTS: Record<ShortcutAction, string> = {
  talk: "Ctrl+Alt+F",
  write: "Ctrl+Alt+T",
  dictate: "Ctrl+Alt+D",
  sleep: "Ctrl+Alt+M",
  avatar: "Ctrl+Alt+H",
};

export const SHORTCUT_LABELS: Record<ShortcutAction, { label: Text; description: Text }> = {
  talk: { label: T("Parler", "Talk"), description: T("Parler à Floppy sans dire son nom (appuyer une fois pour commencer, une fois pour finir).", "Talk to Floppy without saying its name (press once to start, once to stop).") },
  write: { label: T("Écrire à Floppy", "Write to Floppy"), description: T("Saisir une demande traitée comme une demande vocale.", "Type a request handled like a spoken request.") },
  dictate: { label: T("Dicter", "Dictate"), description: T("Dicter du texte dans la fenêtre active.", "Dictate text into the active window.") },
  sleep: { label: T("Dormir / réveiller", "Sleep / wake up"), description: T("Floppy n'écoute plus, ou se réveille.", "Floppy stops listening, or wakes up.") },
  avatar: { label: T("Montrer / cacher l'avatar", "Show / hide the avatar"), description: T("Affiche ou cache l'avatar à l'écran.", "Shows or hides the avatar on screen.") },
};

const MODIFIERS: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", ctl: "Ctrl",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift", maj: "Shift",
  super: "Super", win: "Super", meta: "Super", cmd: "Super", command: "Super",
};
const NAMED_KEYS = ["Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right", "Escape", "Plus"];
const ORDER = ["Ctrl", "Alt", "Shift", "Super"];

/**
 * Lit un raccourci tapé (« ctrl+alt+f », « Control + Alt + F », « alt shift 1 ») et rend sa forme lisible (« Ctrl+Alt+F »).
 * Vide → "" (désactivé). Il faut au moins un modificateur parmi Ctrl, Alt, Super (pour ne pas voler une touche seule).
 */
export function normalizeShortcut(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const parts = text.split(/\s*\+\s*|\s+/).filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (m) { mods.add(m); continue; }
    if (key) throw new TextError(T(`Une seule touche après les modificateurs : « ${text} ».`, `Only one key after the modifiers: “${text}”.`));
    if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase();
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) key = p.toUpperCase();
    else key = NAMED_KEYS.find((k) => k.toLowerCase() === p.toLowerCase()) ?? "";
    if (!key) throw new TextError(T(`Touche inconnue : « ${p} ». Exemples : F, 5, F9, Space.`, `Unknown key: “${p}”. Examples: F, 5, F9, Space.`));
  }
  if (!key) throw new TextError(T("Il manque la touche (ex. Ctrl+Alt+F).", "The key is missing (e.g. Ctrl+Alt+F)."));
  if (!mods.has("Ctrl") && !mods.has("Alt") && !mods.has("Super")) {
    throw new TextError(T("Ajoute Ctrl, Alt ou Super : une touche seule gênerait les autres programmes.", "Add Ctrl, Alt or Super: a single key would get in the way of other programs."));
  }
  return [...ORDER.filter((m) => mods.has(m)), key].join("+");
}
