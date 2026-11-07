// Adaptateurs historiques : une mission nommée a son jeton et son dossier, même si le fork est partagé.
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { T, TextError, type Context } from "@floppy/core";
import type { AgentService, AgentRunInput, BrainService, McpEndpoint } from "@floppy/contracts";
import { agentTools, validAgentModel } from "./offers.ts";

export function scopedAgentRun(ctx: Context, mcp: McpEndpoint, create: (
  scope: McpEndpoint, workspace: string, input: AgentRunInput,
) => BrainService & { stop(): Promise<void> }): NonNullable<AgentService["run"]> {
  return async function* (input) {
    input.signal?.throwIfAborted();
    if (input.model && !validAgentModel(input.model)) throw new TextError(T("Nom de modèle refusé.", "Model name rejected."));
    const scope = mcp.scoped({ tools: agentTools(ctx).map((t) => t.name) });
    let root: string | undefined;
    let dir: string | undefined, brain: ReturnType<typeof create> | undefined;
    try {
      root = ctx.workspace("missions");
      dir = mkdtempSync(join(root, "mission-"));
      brain = create({ ...mcp, ...scope }, dir, input);
      for await (const event of brain.run(input)) {
        input.signal?.throwIfAborted();
        if (event.type === "done") {
          const info = event.info ?? {};
          if (info.error || info.is_error || info.timeout || info.aborted
            || (info.status && !["SUCCESS", "success", "completed", "complete"].includes(String(info.status)))) {
            throw new TextError(T("La mission de l'agent a échoué.", "The agent task failed."));
          }
        }
        yield event;
      }
    } finally {
      try { await brain?.stop(); } finally {
        scope.close();
        if (dir && root && resolve(dir).startsWith(resolve(root) + sep)) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { ctx.log("warn", "dossier temporaire de la mission encore occupé"); }
        }
      }
    }
  };
}
