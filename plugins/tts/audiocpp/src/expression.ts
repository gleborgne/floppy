import type { SpeechDelivery } from "@floppy/contracts";
import { speechStyle } from "@floppy/toolkit";

/** Profils explicites par variante : la famille seule ne garantit pas le même langage de contrôle. */
export function expressionProfile(family: string, model: string, voice: "clone" | "integree"): "instructions" | "fish-s2-tags" | "voxcpm2-style" | "none" {
  const filename = model.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (family === "qwen3_tts" && voice === "integree" && /1[._-]7b.*customvoice/i.test(filename)) return "instructions";
  if (family === "fish_audio" && /fish[-_]audio[-_]s2[-_]pro[-_]/i.test(filename)) return "fish-s2-tags";
  if (family === "voxcpm2" && /^voxcpm2[-_.]/i.test(filename)) return "voxcpm2-style";
  return "none";
}

/** Une seule couleur par phrase, sans variation de débit ni rire automatique. Le texte visible reste intact. */
export function fishDeliveryText(text: string, d: SpeechDelivery): string {
  if (!text.trim()) return text;
  // Une indication explicite d'essai n'est pas doublée par le profil automatique.
  if (/^\s*\[[^\]\r\n]{1,80}\]/.test(text)) return text;
  const tag = speechStyle(d, "en");
  return tag ? `[${tag}] ${text}` : text;
}

/** Convention VoxCPM2/audio.cpp : description parenthésée, référence vocale inchangée. */
export function voxDeliveryText(text: string, d: SpeechDelivery): string {
  if (!text.trim() || /^\s*\([^\)\r\n]{1,300}\)/.test(text)) return text;
  const style = speechStyle(d, "en");
  return style ? `(${style}, natural conversational pace, same speaker voice) ${text}` : text;
}
