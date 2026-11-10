// Vue interne du noyau pour ses modules (fabrique du ctx, réglages du noyau, réglages de choix, slots, forks) : les membres
// privés de la classe Kernel, lus sans élargir son API publique. Jamais offerte aux plugins.
import type { Kernel } from "./kernel.ts";

export type KernelInternals = Omit<Kernel, never> & {
  assistant: Kernel["assistant"];
  appActions: Kernel["appActions"];
  notes: Kernel["notes"];
  logos: Kernel["logos"];
  host: Kernel["host"];
  log: Kernel["log"];
  als: Kernel["als"];
  entries: Kernel["entries"];
  borrowers: Kernel["borrowers"];
  slotDefs: Kernel["slotDefs"];
  enqueue: Kernel["enqueue"];
  reconcile: Kernel["reconcile"];
  hold: Kernel["hold"];
  slotKey: Kernel["slotKey"];
  ensureFork: Kernel["ensureFork"];
  ensureActive: Kernel["ensureActive"];
  candidateOf: Kernel["candidateOf"];
  stopEntry: Kernel["stopEntry"];
  emitState: Kernel["emitState"];
  scheduleRetry: Kernel["scheduleRetry"];
  abortStart: Kernel["abortStart"];
  assistantLang: Kernel["assistantLang"];
  baseCfg: Kernel["baseCfg"];
  applyNow: Kernel["applyNow"];
  slotOptions: Kernel["slotOptions"];
  slotValue: Kernel["slotValue"];
  forks: Kernel["forks"];
  selectionEdits: Kernel["selectionEdits"];
  slotDefaults: Kernel["slotDefaults"];
  all: Kernel["all"];
  startEntry: Kernel["startEntry"];
};
