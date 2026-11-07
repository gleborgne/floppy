// Faux Claude cerveau : modèle choisi et dossier réellement reçus par le CLI.
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const inputs = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {
      models: [{ value: "claude-future", displayName: "Claude Future" }],
    } } });
    return;
  }
  const text = message.message.content[0].text;
  inputs.push(text);
  if (inputs.length === 1) emit({ type: "system", subtype: "init", tools: [] });
  if (text === "crash") { process.exit(1); }
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify({ model: args[args.indexOf("--model") + 1], cwd: process.cwd(), pid: process.pid, inputs }) } } });
  if (text === "lent") return;
  emit({ type: "result", subtype: "success", is_error: false });
});
