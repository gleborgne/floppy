// Faux `codex app-server` pour les étiquettes d'émotion : « script:<JSON> » rejoue des notifications, « prompt » rend les instructions.
// Éléments du script : { item: "a", text: "…" } (morceau d'un message) ou { tool: "nom" } (appel d'outil).
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let base = "";
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start") { base = m.params.baseInstructions; send({ id: m.id, result: { thread: { id: "t1" } } }); }
  else if (m.method === "turn/start") {
    const text = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: "u1" } } });
    const threadId = m.params.threadId;
    const delta = (itemId, d) => send({ method: "item/agentMessage/delta", params: { threadId, itemId, delta: d } });
    if (text === "prompt") delta("a", base.replaceAll("[", "("));
    else for (const step of JSON.parse(text.slice("script:".length))) {
      if (step.tool) send({ method: "item/started", params: { threadId, item: { type: "mcpToolCall", tool: step.tool, arguments: {} } } });
      else delta(step.item, step.text);
    }
    send({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
  }
});
