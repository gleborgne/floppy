// Les journaux décrivent le stockage, sans noms, contenu, portée ni messages d'erreur bruts.
import { TextError } from "@floppy/core";
import type { MemoryOptions } from "@floppy/contracts";

export type StoreOperation = "startup" | "snapshot" | "history.record" | "history.search" | "correction.list" | "correction.save" | "correction.delete" | "markdown.edit";
export interface StoreMetrics {
  count?: number;
  correctionsCount?: number;
  correctionId?: string;
  version?: number;
  outcome?: "inserted" | "updated" | "unchanged" | "deleted" | "missing";
  scopeFiltered?: boolean;
  heardFiltered?: boolean;
  file?: "USER.md" | "MEMORY.md";
}
export interface StoreEvent extends StoreMetrics {
  operation: StoreOperation;
  status: "done" | "failed" | "cancelled";
  duration_ms: number;
  reason?: "rejected" | "storage" | "cancelled";
  session?: string;
  origin?: string;
  turn?: string;
  callId?: string;
}
export type StoreReporter = (event: StoreEvent) => void;

/** L'audit ne peut ni masquer un échec, ni faire échouer une écriture déjà terminée. */
export function storeOperation<R>(report: StoreReporter | undefined, operation: StoreOperation, work: () => R,
  metrics?: (result: R) => StoreMetrics, options?: MemoryOptions, failureOnly = false): R {
  const start = performance.now();
  const emit = (event: Omit<StoreEvent, "operation" | "duration_ms">) => {
    try { report?.({ operation, duration_ms: Math.max(0, performance.now() - start),
      ...(options?.session ? { session: options.session } : {}), ...(options?.origin ? { origin: options.origin } : {}),
      ...(options?.turn ? { turn: options.turn } : {}), ...(options?.callId ? { callId: options.callId } : {}), ...event }); }
    catch { /* Le stockage reste la source de vérité, même si son journal est indisponible. */ }
  };
  try {
    const result = work();
    if (!failureOnly) emit({ status: "done", ...metrics?.(result) });
    return result;
  } catch (error) {
    const cancelled = options?.signal?.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
    emit({ status: cancelled ? "cancelled" : "failed", reason: cancelled ? "cancelled" : error instanceof TextError ? "rejected" : "storage" });
    throw error;
  }
}
