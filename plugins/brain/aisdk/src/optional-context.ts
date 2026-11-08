import type { Context } from "@floppy/core";

export interface ContextOperation {
  service: "memory" | "vocabulary";
  consumer: "brain" | "conversation" | "live";
  phase: "snapshot" | "context" | "record" | "observe";
  session: string; origin?: string; turn: string; parent?: AbortSignal; available: boolean;
}

/** Un fournisseur facultatif en panne ou muet ne doit jamais retenir la conversation. */
export async function optionalContext<T>(work: (signal: AbortSignal) => T | Promise<T>, ctx: Pick<Context, "log" | "audit">, operation: ContextOperation): Promise<T | undefined> {
  const deadline = AbortSignal.timeout(500);
  const signal = operation.parent ? AbortSignal.any([operation.parent, deadline]) : deadline;
  const started = performance.now();
  let outcome = operation.available ? "ready" : "unavailable";
  let expired: (() => void) | undefined;
  try {
    if (!operation.available) return undefined;
    signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }),
      new Promise<never>((_, reject) => {
        expired = () => reject(signal.reason);
        signal.addEventListener("abort", expired, { once: true });
      }),
    ]);
  } catch {
    outcome = operation.parent?.aborted ? "aborted" : deadline.aborted ? "timeout" : "failed";
    if (outcome !== "aborted") ctx.log("warn", "Contexte facultatif indisponible ; conversation poursuivie sans lui");
    return undefined;
  } finally {
    if (expired) signal.removeEventListener("abort", expired);
    ctx.audit.write({ kind: "memory.context", service: operation.service, phase: operation.phase,
      consumer: operation.consumer,
      session: operation.session, ...(operation.origin ? { origin: operation.origin } : {}), turn: operation.turn,
      outcome, ...(outcome === "ready" ? {} : { reason: outcome === "failed" ? "provider_error" : outcome === "timeout" ? "deadline" : outcome === "aborted" ? "turn_aborted" : "service_missing" }),
      duration_ms: Math.round(performance.now() - started) });
  }
}
