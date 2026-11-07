// Agents externes : chaque plugin offre son agent ; les consommateurs empruntent celui demandé.
import type { BrainEvent, BrainRunInput } from "./brain.ts";

export interface AgentRunInput extends BrainRunInput {
  /** Choix ponctuel, sans modifier les réglages du cerveau. */
  model?: string;
}

export interface AgentService {
  id: string;
  label: string;
  aliases: string[];
  /** Prépare une session interactive avec les droits propres de l'agent. */
  interactive(input: { prompt: string; model?: string }): { command: string; args: string[] };
  /** Présent seulement si l'adaptateur sait limiter les outils au registre Floppy. */
  run?(input: AgentRunInput): AsyncIterable<BrainEvent>;
}

declare module "@floppy/core" {
  interface Services {
    agent: AgentService;
  }
}
