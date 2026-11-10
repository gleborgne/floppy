// API publique de @floppy/toolkit : le code que les plugins du dépôt se partagent (avatars, mise en voix et
// émotions, contexte mémorisé, contribution de bureau). Les contrats (types) restent dans @floppy/contracts.
// Dépend du noyau et des contrats, jamais l'inverse ; un plugin l'importe, il n'importe jamais un autre plugin.
export * from "./memory-context.ts";
export { EMOTION_SHEET, emotionInfo, expressivenessFactor, type EmotionInfo, type GestureRole } from "./emotion-sheet.ts";
export { EmotionTagFilter, filterEvents, emotionTagPrompt, PROMPT_EMOTIONS_EN, type FilterOut } from "./emotion-tags.ts";
export { speechInstructions, speechStyle, liveDeliveryInstructions, emotionNote } from "./speech-delivery.ts";
export { defineAvatar, readAvatarDir } from "./avatars.ts";
export { registerDesktop } from "./desktop.ts";
