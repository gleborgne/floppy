// Contrats des services entre plugins, rangés par domaine. Le noyau ne les connaît pas : chaque fichier ajoute
// ses services à l'interface `Services` du noyau (augmentation de module, comme Cordis). Un plugin importe d'ici
// les types des services qu'il fournit ou utilise ; il ne s'importe jamais avec un autre plugin.
export type * from "./brain.ts";
export type * from "./memory.ts";
export * from "./memory-context.ts";
export type * from "./vocabulary.ts";
export type * from "./agents.ts";
export type * from "./voice.ts";
export { EMOTION_SHEET, emotionInfo, expressivenessFactor, type EmotionInfo, type GestureRole } from "./emotion-sheet.ts";
export { EmotionTagFilter, filterEvents, emotionTagPrompt, PROMPT_EMOTIONS_EN, type FilterOut } from "./emotion-tags.ts";
export { speechInstructions, speechStyle, liveDeliveryInstructions } from "./speech-delivery.ts";
export type * from "./coder.ts";
export type * from "./mcp.ts";
export type * from "./body.ts";
export type * from "./search.ts";
export type * from "./notify.ts";
export { defineAvatar, readAvatarDir } from "./avatars.ts";
export { registerDesktop, type DesktopContribution, type DesktopRegistration, type DesktopContent } from "./desktop.ts";
