// Faux Claude cerveau : modèle choisi et dossier réellement reçus par le CLI.
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
createInterface({ input: process.stdin }).once("line", () => {
  emit({ type: "system", subtype: "init", tools: [] });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify({ model: args[args.indexOf("--model") + 1], cwd: process.cwd() }) } } });
  emit({ type: "result", subtype: "success", is_error: false });
});
