// Faux `agy` pour les étiquettes d'émotion : « script:<JSON> » rejoue des étapes, « prompt » rend le prompt de l'agent.
// Éléments du script : { step: 1, text: "…" } (morceau d'une étape) ou { tool: "nom", step: 2 } (appel d'outil MCP).
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).once("line", (l) => {
  const text = JSON.parse(l).message.content;
  const say = (step, d) => send({ event: "step_update", step_update: { step_index: step, step_type: "agent_response", text_delta: d } });
  if (text === "prompt") say(1, readFileSync(join(process.cwd(), ".agents", "agents", "floppy.md"), "utf8").replaceAll("[", "("));
  else for (const s of JSON.parse(text.slice("script:".length))) {
    if (s.tool) send({ event: "step_update", step_update: { step_index: s.step, tool_name: "call_mcp_tool", tool_info: { parameters: { ToolName: s.tool, Arguments: {} } } } });
    else say(s.step, s.text);
  }
  send({ event: "result", result: { status: "SUCCESS" } });
});
