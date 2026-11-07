// Données de l'assistant IA (service « coder » du noyau, via window.floppyCoder). Types seulement : rien n'est émis.
// Miroir de packages/contracts/src/coder.ts côté fenêtre (la page n'importe pas le noyau).

/** Texte du noyau : chaîne simple ou { fr, en }. */
type CoderText = string | { fr?: string; en?: string; [lang: string]: string | undefined };

interface CoderAgent {
  id: string;
  label: CoderText;
  available: boolean;
  loginHint?: CoderText;
}

/** Réponse à l'ouverture d'une conversation. */
interface CoderStart {
  ok: boolean;
  sessionId?: string;
  error?: CoderText;
}

interface CoderDiff { path: string; before?: string; after?: string }

type CoderEvent =
  | { type: "status"; sessionId: string; status: "starting" | "ready" | "busy" }
  | { type: "text"; sessionId: string; delta?: string }
  | { type: "tool"; sessionId?: string; id: string; name?: string; input?: unknown; status: "running" | "done" | "failed"; output?: string }
  | { type: "permission"; sessionId?: string; id: string; tool: string; description?: string; input?: unknown; diff?: CoderDiff }
  | { type: "done"; sessionId: string; stopReason?: "end" | "cancelled" | "error"; error?: CoderText; signIn?: boolean };
