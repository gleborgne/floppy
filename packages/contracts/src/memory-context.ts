import type { Context } from "@floppy/core";
import type { MemoryService, MemorySnapshot } from "./memory.ts";
import type { VocabularyService } from "./vocabulary.ts";

// Types du contexte mémorisé que le cerveau et la conversation s'échangent ; le code qui le prépare
// (`prepareMemoryContext`, `optionalContext`) vit dans @floppy/toolkit.

export interface ContextOperation {
  service: "memory" | "vocabulary";
  consumer: "brain" | "conversation" | "live";
  phase: "snapshot" | "context" | "record" | "observe";
  session: string; origin?: string; turn: string; parent?: AbortSignal; available: boolean;
}

/** Photo autoritaire : vide, indisponible et absent sont trois états distincts. */
export interface PreparedMemoryContext extends MemorySnapshot {
  vocabulary: string;
  availability: { memory: "ready" | "unavailable" | "absent"; vocabulary: "ready" | "unavailable" | "absent" };
  warning?: string;
}

export interface MemoryContextDeps {
  memory?: MemoryService;
  vocabulary?: VocabularyService;
  diagnostics: Pick<Context, "log" | "audit">;
}
export interface MemoryContextInput {
  session: string; origin?: string; turn: string; heard?: string; language: string;
  consumer: ContextOperation["consumer"]; signal?: AbortSignal;
}
