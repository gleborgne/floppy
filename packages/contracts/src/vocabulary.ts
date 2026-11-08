import type { MemoryCorrection, MemoryCorrectionScope } from "./memory.ts";

/** Interprétation du vocabulaire personnel ; ne modifie jamais une transcription ni un message. */
export interface VocabularyService {
  /** Appelé uniquement sur le texte brut d'un véritable tour utilisateur, avant le cerveau. */
  observe(input: { text: string; session: string; origin?: string; turn?: string }): void;
  /** Consignes et candidats cités comme données, dans la langue de l'assistant. */
  context(query?: { heard?: string; scope?: MemoryCorrectionScope; session?: string; origin?: string; turn?: string; signal?: AbortSignal }): Promise<string>;
  /** Correspondance du fragment entier et de la portée exacte ; une ambiguïté reste une ambiguïté. */
  resolve(query: { heard: string; scope: MemoryCorrectionScope; session?: string; origin?: string; turn?: string; signal?: AbortSignal }): Promise<{
    status: "none" | "match" | "ambiguous";
    candidates: MemoryCorrection[];
  }>;
}

declare module "@floppy/core" {
  interface Services {
    vocabulary: VocabularyService;
  }
}
