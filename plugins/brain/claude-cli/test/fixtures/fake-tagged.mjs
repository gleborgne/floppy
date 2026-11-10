// Faux Claude pour les étiquettes d'émotion : « script:<JSON> » rejoue des morceaux de flux, « prompt » rend le prompt système.
// Éléments du script : { text: "…" } (morceau de texte), { block: true } (nouveau bloc de texte), { tool: "nom" } (appel d'outil).
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const delta = (text) => emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
let first = true;
createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content[0].text;
  if (first) { emit({ type: "system", subtype: "init", tools: [] }); first = false; }
  if (text === "prompt") delta(args[args.indexOf("--system-prompt") + 1].replaceAll("[", "("));
  else for (const step of JSON.parse(text.slice("script:".length))) {
    if (step.text !== undefined) delta(step.text);
    else if (step.block) emit({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    else if (step.tool) {
      emit({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } });
      emit({ type: "assistant", message: { content: [{ type: "tool_use", name: `mcp__floppy__${step.tool}`, input: {} }] } });
    }
  }
  emit({ type: "result", subtype: "success", is_error: false });
});
