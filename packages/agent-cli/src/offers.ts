// Catalogue d'agents fondé sur les offres du noyau : aucun registre global ni import de plugin.
import { TextError, T, findExe, fold, type Context, type Borrowed } from "@floppy/core";
import { existsSync } from "node:fs";
import type { AgentService } from "@floppy/contracts";
import { agentCommand } from "./command.ts";

/** Une mission ne peut pas en ouvrir d'autres ni ouvrir un terminal pour contourner ses outils. */
export const agentTools = (ctx: Context) => ctx.tools.list().filter((t) => !["deleguer_agent", "lancer_travail_agent", "ouvrir_session_agent"].includes(t.name));

export interface AgentDefinition {
  id: string;
  label: string;
  program: string;
  aliases: string[];
  args(prompt: string, model: string | undefined, workspace: string): string[];
}

/** Les modèles provider/model sont permis, jamais des options ou du texte de shell. */
export const validAgentModel = (model: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/@+#-]{0,199}$/.test(model);

const normalize = (s: string) => fold(s.trim());

/** Le nom complet entrée/élément lève toute ambiguïté entre deux profils du même agent. */
export async function borrowAgent(ctx: Context, query: string): Promise<Borrowed<AgentService> | undefined> {
  const offers = ctx.offers("agent");
  const exact = offers.find((o) => o.value === query);
  if (exact) return ctx.borrowItem<AgentService>("agent", exact.value);
  let found: Borrowed<AgentService> | undefined;
  try {
    for (const offer of offers) {
      const borrowed = await ctx.borrowItem<AgentService>("agent", offer.value);
      if (!borrowed) continue;
      const a = borrowed.service;
      if ([a.id, a.label, ...a.aliases].some((s) => normalize(s) === normalize(query))) {
        if (found) {
          borrowed.release();
          throw new TextError(T("Plusieurs profils correspondent à cet agent. Indique son identifiant complet entrée/agent.", "Several profiles match this agent. Specify its full entry/agent identifier."));
        }
        found = borrowed;
      } else borrowed.release();
    }
    return found;
  } catch (e) { found?.release(); throw e; }
}

export function offerAgent(ctx: Context, def: AgentDefinition, opts: {
  exe(): string | undefined;
  enabled?(): boolean;
  cloud?: boolean | (() => boolean);
  run?(fork: Context): NonNullable<AgentService["run"]>;
}): void {
  ctx.offer("agent", {
    items: () => {
      const exe = opts.exe();
      return exe && (existsSync(exe) || findExe(exe)) && (opts.enabled?.() ?? true)
        ? [{ id: def.id, label: def.label, aliases: def.aliases, cloud: typeof opts.cloud === "function" ? opts.cloud() : opts.cloud ?? true }] : [];
    },
    start(f) {
      const command = opts.exe();
      if (!command) throw new TextError(T(`${def.label} est introuvable.`, `${def.label} was not found.`));
      f.provide("agent", {
        id: def.id, label: def.label, aliases: def.aliases,
        interactive({ prompt, model }) {
          if (model && !validAgentModel(model)) throw new TextError(T("Nom de modèle refusé.", "Model name rejected."));
          return agentCommand(command, def.args(prompt, model, f.workspace("interactive")));
        },
        ...(opts.run ? { run: opts.run(f) } : {}),
      });
    },
  });
}
