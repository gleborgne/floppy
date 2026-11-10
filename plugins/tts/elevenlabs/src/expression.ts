import { speechStyle, type SpeechDelivery } from "@floppy/contracts";

/** Les modèles Flash/v2 ne comprennent pas les balises de jeu des modèles v3/v4. */
export function deliveryText(text: string, model: string, delivery?: SpeechDelivery): string {
  if (!delivery || !/^eleven_v[34](?:_turbo)?$/.test(model) || !text.trim() || /^\s*\[[^\]\r\n]{1,80}\]/.test(text)) return text;
  const style = speechStyle(delivery, "en");
  return style ? `[${style}] ${text}` : text;
}
