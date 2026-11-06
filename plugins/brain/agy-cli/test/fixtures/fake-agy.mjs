// Faux `agy` en stream-json : lit une demande, renvoie en texte ce qu'il a reçu (arguments, maison, fichiers préparés).
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).once("line", (l) => {
  const text = JSON.parse(l).message.content;
  const home = process.env.USERPROFILE;
  if (text === "outil") {
    const schemas = join(home, ".gemini", "antigravity-cli", "mcp", "floppy", "agenda_du_jour.json");
    send({ event: "step_update", step_update: { step_index: 1, tool_name: "view_file", tool_info: { parameters: { AbsolutePath: schemas } } } });
    send({ event: "step_update", step_update: { step_index: 2, tool_name: "call_mcp_tool", tool_info: { parameters: { ServerName: "floppy", ToolName: "agenda_du_jour", Arguments: {} } } } });
    send({ event: "step_update", step_update: { step_index: 3, tool_name: "search_web", tool_info: { parameters: {} } } });
    send({ event: "step_update", step_update: { step_index: 4, step_type: "agent_response", text_delta: "Rien aujourd'hui." } });
    send({ event: "result", result: { status: "SUCCESS" } });
    return;
  }
  const reply = JSON.stringify({
    args, home,
    mcp: JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8")),
    agent: readFileSync(join(process.cwd(), ".agents", "agents", "floppy.md"), "utf8"),
  });
  send({ event: "init", init: { model: "x" } });
  send({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: reply } });
  send({ event: "result", result: { status: "SUCCESS" } });
});
