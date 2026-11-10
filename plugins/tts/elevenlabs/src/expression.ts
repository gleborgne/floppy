import { type SpeechDelivery } from "@floppy/contracts";
import { speechStyle } from "@floppy/toolkit";

/** Seuls les modèles v3/v4 comprennent les balises de jeu (les Flash/v2 les liraient ou les ignoreraient). */
export const playsEmotions = (model: string): boolean => /^eleven_v[34](?:_turbo)?$/.test(model);

export function deliveryText(text: string, model: string, delivery?: SpeechDelivery): string {
  if (!delivery || !playsEmotions(model) || !text.trim() || /^\s*\[[^\]\r\n]{1,80}\]/.test(text)) return text;
  const style = speechStyle(delivery, "en");
  return style ? `[${style}] ${text}` : text;
}
