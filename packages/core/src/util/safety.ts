// Filet global du processus du noyau : une erreur asynchrone oubliée par un plugin ne tue plus tout Floppy.
// Le noyau l'attribue au plugin fautif quand il le peut (Kernel.blame) ; sinon elle est seulement écrite au journal.

export type SafetyKind = "unhandledRejection" | "uncaughtException";

export interface SafetyNetOptions {
  /** Appelé pour chaque erreur rattrapée. */
  onError(kind: SafetyKind, error: unknown): void;
  /** Trop d'erreurs non rattrapées en peu de temps : l'état n'est plus sûr, on laisse l'hôte relancer le noyau. */
  maxUncaught?: number;
  windowMs?: number;
  exit?: (code: number) => void;
}

/** Installe les gestionnaires `unhandledRejection` et `uncaughtException`. Rend la fonction qui les retire. */
export function installSafetyNet(opts: SafetyNetOptions): () => void {
  const max = opts.maxUncaught ?? 20;
  const windowMs = opts.windowMs ?? 60_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let times: number[] = [];
  const report = (kind: SafetyKind, error: unknown) => {
    try { opts.onError(kind, error); } catch (e) { console.error("[safety] rapport impossible", e, error); }
  };
  const onRejection = (reason: unknown) => report("unhandledRejection", reason);
  const onException = (error: unknown) => {
    report("uncaughtException", error);
    const now = Date.now();
    times = [...times.filter((t) => now - t < windowMs), now];
    if (times.length >= max) {
      console.error(`[safety] ${times.length} erreurs non rattrapées en ${Math.round(windowMs / 1000)} s : arrêt du noyau`);
      exit(1);
    }
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
