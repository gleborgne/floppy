import type { SpeechDelivery } from "@floppy/contracts";

/** Profils explicites par variante : la famille seule ne garantit pas le même langage de contrôle. */
export function expressionProfile(family: string, model: string, voice: "clone" | "integree"): "instructions" | "fish-s2-tags" | "none" {
  const filename = model.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (family === "qwen3_tts" && voice === "integree" && /1[._-]7b.*customvoice/i.test(filename)) return "instructions";
  if (family === "fish_audio" && /fish[-_]audio[-_]s2[-_]pro[-_]/i.test(filename)) return "fish-s2-tags";
  return "none";
}

/** Une seule couleur par phrase, sans variation de débit ni rire automatique. Le texte visible reste intact. */
export function fishDeliveryText(text: string, d: SpeechDelivery): string {
  if (!text.trim()) return text;
  // Une indication explicite d'essai n'est pas doublée par le profil automatique.
  if (/^\s*\[[^\]\r\n]{1,80}\]/.test(text)) return text;
  const subtle = d.profile === "discreet" || (d.intensity !== undefined && d.intensity < 0.5);
  let tag: string;
  if (d.intent === "reassure") tag = "soft tone";
  else if (d.emotion === "curious" && !subtle) tag = "curious";
  else if (d.intent === "playful") tag = subtle ? "slightly amused" : d.profile === "playful" ? "warm and playful" : "warm and friendly";
  else if (d.intent === "explain") tag = subtle ? "calm" : "clear and engaging";
  else tag = subtle ? "" : d.profile === "playful" ? "warm and friendly" : "relaxed";
  return tag ? `[${tag}] ${text}` : text;
}
