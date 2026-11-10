// Textes du processus principal de l'app (menu, barre des tâches, titres des fenêtres), en français et en anglais.
export type Lang = "fr" | "en";
export type TextKey = Exclude<keyof typeof fr, "problemNames">;

const fr = {
  write: "Conversation (Ctrl+Alt+T)", chatTitle: "Floppy — Conversation", openChat: "Ouvrir la conversation",
  problem: "problème", idle: "prêt", listening: "écoute", thinking: "réfléchit", speaking: "parle", sleep: "dort", starting: "démarrage…",
  waits: "attend", pttStop: "Arrêter de parler (Ctrl+Alt+F)", pttStart: "Parler (Ctrl+Alt+F)",
  dictating: "dictée", dictateStart: "Dicter (Ctrl+Alt+D)", dictateStop: "Arrêter la dictée (Ctrl+Alt+D)", replace: "Remettre en bas à droite", wake: "Réveiller (Ctrl+Alt+M)", mute: "Dormir (Ctrl+Alt+M)",
  hide: "Cacher l'avatar (Ctrl+Alt+H)", show: "Montrer l'avatar (Ctrl+Alt+H)", settings: "Réglages…", restart: "Relancer le noyau",
  logs: "Ouvrir le dossier des journaux", quit: "Quitter", settingsTitle: "Floppy — Réglages", panelTitle: "Floppy — Résultats", documentsTitle: "Floppy — Documents", noKernel: "Le noyau n'est pas démarré.", noAnswer: "Le noyau n'a pas répondu.",
  pickTitle: "Choisir", invalid: "Demande invalide.", taken: "déjà pris",
  problemNames: { dictation: "dictée", shortcut: "raccourci", kernel: "noyau" },
  kernelLoop: "le noyau s'arrête sans cesse. Lis le journal, puis choisis « Relancer le noyau ».",
  onboardingTitle: "Floppy — Bienvenue", firstSetup: "Réglage de départ…",
  settingsNotOpened: "Réglages non ouverts", closedWhileLoading: "fenêtre fermée pendant le chargement", loadTooLong: "chargement trop long", notVisible: "fenêtre non visible",
};
const en: typeof fr = {
  write: "Conversation (Ctrl+Alt+T)", chatTitle: "Floppy — Conversation", openChat: "Open the conversation",
  problem: "problem", idle: "ready", listening: "listening", thinking: "thinking", speaking: "speaking", sleep: "asleep", starting: "starting…",
  waits: "waiting for", pttStop: "Stop talking (Ctrl+Alt+F)", pttStart: "Talk (Ctrl+Alt+F)",
  dictating: "dictation", dictateStart: "Dictate (Ctrl+Alt+D)", dictateStop: "Stop dictation (Ctrl+Alt+D)", replace: "Move back to bottom right", wake: "Wake up (Ctrl+Alt+M)", mute: "Sleep (Ctrl+Alt+M)",
  hide: "Hide the avatar (Ctrl+Alt+H)", show: "Show the avatar (Ctrl+Alt+H)", settings: "Settings…", restart: "Restart the kernel",
  logs: "Open the logs folder", quit: "Quit", settingsTitle: "Floppy — Settings", panelTitle: "Floppy — Results", documentsTitle: "Floppy — Documents", noKernel: "The kernel is not running.", noAnswer: "The kernel did not answer.",
  pickTitle: "Choose", invalid: "Invalid request.", taken: "already taken",
  problemNames: { dictation: "dictation", shortcut: "shortcut", kernel: "kernel" },
  kernelLoop: "the kernel keeps stopping. Read the log, then choose \"Restart the kernel\".",
  onboardingTitle: "Floppy — Welcome", firstSetup: "First setup…",
  settingsNotOpened: "Settings not opened", closedWhileLoading: "window closed while loading", loadTooLong: "loading took too long", notVisible: "window not visible",
};
export const TEXTS: Record<Lang, typeof fr> = { fr, en };
// Raccourcis affichés selon le système : sur Mac, Ctrl+Alt s'écrit ⌃⌥ (la touche Alt s'appelle Option).
export const keysForOS = (s: string): string => (process.platform === "darwin" ? s.replaceAll("Ctrl+Alt+", "⌃⌥") : s);
