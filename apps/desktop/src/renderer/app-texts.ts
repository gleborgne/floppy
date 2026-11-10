// Textes de la page de l'avatar (fr / en).
// Ce qu'on lit (bulle, cartes) suit la langue de l'interface (message display) ; ce que Floppy dit (résultats d'outils,
// repris par le cerveau) suit la langue de l'assistant (message welcome du noyau).
import { $, type CardEl } from "./app-dom.ts";

export type Lang = "fr" | "en";
export type TextKey = "you" | "listen" | "stopListening" | "faceTip" | "closeTip" | "micDown" | "ask" | "yes" | "no" | "important" | "info" | "error";
const TEXTS: Record<Lang, Record<TextKey, string>> = {
  fr: {
    you: "Toi", listen: "Je t'écoute…", stopListening: "Arrêter l'écoute", faceTip: "Floppy — Ctrl+Alt+F pour parler", closeTip: "Cliquer pour fermer",
    micDown: "Micro indisponible", ask: "Ton accord ?", yes: "Oui", no: "Non", important: "Important", info: "Info", error: "Erreur",
  },
  en: {
    you: "You", listen: "I'm listening…", stopListening: "Stop listening", faceTip: "Floppy — Ctrl+Alt+F to talk", closeTip: "Click to close",
    micDown: "Microphone unavailable", ask: "Your approval?", yes: "Yes", no: "No", important: "Important", info: "Info", error: "Error",
  },
};
const SAID: Record<Lang, { cardShown: string; unknownTool: (n: string) => string }> = {
  fr: { cardShown: "Carte affichée.", unknownTool: (n) => `outil inconnu : ${n}` },
  en: { cardShown: "Card displayed.", unknownTool: (n) => `unknown tool: ${n}` },
};
type SaidKey = keyof (typeof SAID)["fr"];
const isLang = (l: string): l is Lang => l === "fr" || l === "en";

export interface Texts {
  /** Texte de l'interface dans sa langue. */
  L(k: TextKey): string;
  /** Texte dit par Floppy (résultat d'outil), dans la langue de l'assistant. */
  S<K extends SaidKey>(k: K): (typeof SAID)["fr"][K];
  /** Texte { fr, en } (ou simple) dans la langue de l'assistant. */
  said(x: unknown): string;
  /** Langue de l'interface (message display) ; ignorée si inconnue ou inchangée. */
  setLang(l: string): void;
  /** Langue de l'assistant (message welcome). */
  setAssistantLang(l: string): void;
  /** Raccourci « parler » choisi dans les réglages (message display) ; vide = désactivé. */
  setTalkKeys(keys: string): void;
}

/** Propriétaire de la langue de l'interface, de celle de l'assistant et du raccourci « parler ». */
export function createTexts(): Texts {
  let lang: Lang = "fr";      // langue de l'interface
  let assistantLang = "";     // langue de l'assistant (welcome) ; vide : celle de l'interface
  // Sur Mac, Ctrl+Alt s'écrit ⌃⌥ (la touche Alt s'appelle Option).
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  let talkKeys = "Ctrl+Alt+F";
  const L = (k: TextKey): string => {
    let s = (TEXTS[lang] ?? TEXTS.fr)[k] ?? TEXTS.fr[k];
    if (k === "faceTip") s = talkKeys ? s.replace("Ctrl+Alt+F", talkKeys) : "Floppy";
    return isMac ? s.replaceAll("Ctrl+Alt+", "⌃⌥") : s;
  };
  const S = <K extends SaidKey>(k: K) => (isLang(assistantLang) ? SAID[assistantLang] : SAID[lang] ?? SAID.fr)[k];
  const said = (x: unknown): string => {
    if (x && typeof x === "object") { const o = x as Record<string, string | undefined>; return o[assistantLang] ?? o[lang] ?? o.fr ?? ""; }
    return String(x ?? "");
  };
  function applyTexts() {
    document.documentElement.lang = lang;
    $("listenLabel").textContent = L("listen");
    $("stopListening").setAttribute("title", L("stopListening"));
    $("stopListening").setAttribute("aria-label", L("stopListening"));
    $("faceWrap")?.setAttribute("title", L("faceTip"));
    const you = $("you")?.querySelector("b");
    if (you) you.textContent = L("you");
    // Cartes déjà affichées : leurs textes fixes changent de langue.
    for (const c of [...($("cards")?.children ?? [])] as CardEl[]) c._relabel?.();
  }
  return {
    L, S, said,
    setLang(l) {
      if (!isLang(l) || l === lang) return;
      lang = l;
      applyTexts();
    },
    setAssistantLang(l) { assistantLang = l; },
    setTalkKeys(keys) {
      if (keys === talkKeys) return;
      talkKeys = keys;
      $("faceWrap")?.setAttribute("title", L("faceTip"));
    },
  };
}
