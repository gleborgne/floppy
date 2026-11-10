// Historique de session du cerveau : compté en échanges (une demande de l'utilisateur et tout ce qui suit jusqu'à la suivante).
import type { ModelMessage } from "ai";

/** Longueur gardée d'un résultat d'outil dans un échange ancien. */
export const OLD_TOOL_CHARS = 400;

/** Découpe en échanges. Les messages avant la 1re demande (résultat d'outil orphelin) sont écartés. */
export function splitExchanges(messages: ModelMessage[]): ModelMessage[][] {
  const out: ModelMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user") out.push([m]);
    else out.at(-1)?.push(m);
  }
  return out;
}

const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** Raccourcit les résultats d'outils d'un échange (texte ou JSON) ; le reste est inchangé. */
function shortenTools(exchange: ModelMessage[], max: number): ModelMessage[] {
  return exchange.map((m) => {
    if (m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const o = part.output as { type: string; value?: unknown };
        if (o.type === "text" || o.type === "error-text") {
          const v = String(o.value ?? "");
          return v.length > max ? { ...part, output: { ...o, value: cut(v, max) } as typeof part.output } : part;
        }
        if (o.type === "json" || o.type === "error-json") {
          const v = JSON.stringify(o.value ?? null);
          return v.length > max ? { ...part, output: { type: o.type === "json" ? "text" : "error-text", value: cut(v, max) } as typeof part.output } : part;
        }
        return part;
      }),
    } as ModelMessage;
  });
}

/**
 * Garde les `max` derniers échanges. Les résultats d'outils de tous les échanges sauf le dernier sont raccourcis
 * (un mail entier ne reste pas en mémoire courte). Jamais de résultat d'outil sans demande devant lui.
 */
export function compactHistory(messages: ModelMessage[], max: number, toolChars = OLD_TOOL_CHARS): ModelMessage[] {
  const ex = splitExchanges(messages).slice(-Math.max(1, max));
  return ex.flatMap((e, i) => (i === ex.length - 1 ? e : shortenTools(e, toolChars)));
}
