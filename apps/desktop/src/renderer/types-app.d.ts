// Formes des données venues du noyau (via le processus principal) pour les fenêtres avatar, résultats, documents et bienvenue.
// Le noyau ne partage pas ces types : ce sont les champs que les pages lisent (le reste est ignoré).

/** Texte simple, ou { fr, en } venu du noyau. */
type AppText = string | { fr?: string; en?: string } | null | undefined;

// ---- Fenêtre de résultats (A2UI v0.8, sous-ensemble)
interface A2uiValue { literalString?: string }
interface A2uiChildren { explicitList?: string[] }
interface A2uiAction { name?: string; context?: { key?: string; value?: string | A2uiValue }[] }
interface A2uiProps {
  children?: A2uiChildren; child?: string; usageHint?: string; text?: string | A2uiValue; url?: string | A2uiValue;
  primary?: boolean; action?: A2uiAction;
}
interface A2uiMessage {
  surfaceUpdate?: { components?: { id?: string; component?: Record<string, A2uiProps> }[] };
  beginRendering?: { root?: string };
}
interface PanelShow { title?: string; lang?: string; a2ui?: A2uiMessage[] }

// ---- Fenêtre Documents
interface DocEntry { id: string; titre: string; date: string; tags: string[] }
interface DocsShow { id?: string; titre?: string; html?: string; lang?: string; liste?: DocEntry[] }

// ---- Fenêtre Bienvenue
interface OnboardingRow { state: string; progress?: number; text?: AppText; label?: AppText; role: string }
/** Avancement de l'installation de départ. */
interface OnboardingState { phase: string; rows: OnboardingRow[]; notes: AppText[]; live?: boolean }
interface OnboardingMachine {
  gpu?: { name: string } | null; memory?: string; modelBytes?: number; ramBytes?: number; diskFreeBytes?: number;
  sources?: unknown[];
}
interface OnboardingLevel {
  id: string; label?: AppText; description?: AppText; possible: boolean; reason?: AppText; downloadBytes: number;
  brain?: string; picks: { label?: AppText }[];
}
interface OnboardingCloudBrain { value: string; label?: AppText; found?: boolean }
interface OnboardingAgent { plugin: string; label?: AppText; found?: boolean; entries: unknown[]; section?: string }
interface OnboardingPlan {
  machine: OnboardingMachine; levels: OnboardingLevel[]; recommended?: string; brain?: string | null; lang?: string;
  cloudBrains: OnboardingCloudBrain[]; agents?: OnboardingAgent[]; home?: string; state?: OnboardingState | null;
}
/** Réponse du noyau à une demande de la fenêtre Bienvenue. */
interface OnboardingReply<T = unknown> { ok?: boolean; canceled?: boolean; text?: AppText; value?: T }

// ---- Avatar (plugin : plugins/avatar/<id>/renderer/index.js)
interface AvatarInstance {
  setState(state: string): void;
  setEmotion(name: string, intensity?: number, ms?: number): void;
  setLevel(level: number): void;
  setMood?(valence: number, energy: number): void;
  /** Forme de la bouche d'après le son, en plus de setLevel : open 0..1, wide 0 (arrondie « o ») .. 1 (étirée « i », « s »). */
  setMouth?(open: number, wide: number): void;
  lookAt?(x: number, y: number): void;
  setHearing?(level: number): void;
  cue?(name: string): void;
  setAttention?(target: string): void;
  setSpeechTime?(seconds: number): void;
  setSpeechGesture?(intent: import("@floppy/protocol").SpeechGesture | null, intensity?: number, at?: number): void;
  destroy(): void;
}
interface AvatarModule { create(box: HTMLElement, opts: { reducedMotion: boolean; motion: Pick<import("./avatar-motion.ts").AvatarMotion, "sample" | "gaze"> }): AvatarInstance }
