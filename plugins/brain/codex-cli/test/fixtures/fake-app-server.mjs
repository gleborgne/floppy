// Faux `codex app-server` : répond au protocole JSON-RPC et renvoie, en texte, ce qu'il a reçu (arguments, modèle, prompt).
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let thread = 0;
const threads = new Map();
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start") { const id = `t${++thread}`; threads.set(id, m.params); send({ id: m.id, result: { thread: { id } } }); }
  else if (m.method === "turn/start") {
    const th = threads.get(m.params.threadId);
    const text = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: "u1" } } });
    if (text === "outil") {
      send({ method: "item/started", params: { threadId: m.params.threadId, item: { type: "mcpToolCall", tool: "agenda_du_jour", arguments: {} } } });
      // Le CLI demande l'accord pour une commande : Floppy doit refuser.
      send({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: m.params.threadId, command: "dir" } });
      th.pendingThread = m.params.threadId;
      return;
    }
    if (text === "lent") { // commence, puis ne finit jamais (annulation)
      send({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, itemId: "a", delta: "Je cherche" } });
      return;
    }
    const reply = JSON.stringify({ model: th.model, thread: m.params.threadId, sandbox: th.sandbox, policy: th.approvalPolicy, hasPrompt: th.baseInstructions.includes("Floppy"), args });
    send({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, itemId: "a", delta: reply } });
    send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { status: "completed" } } });
  } else if (m.id === 99) {
    const t = [...threads.keys()].at(-1);
    send({ method: "item/agentMessage/delta", params: { threadId: t, itemId: "b", delta: `decision:${m.result.decision}` } });
    send({ method: "turn/completed", params: { threadId: t, turn: { status: "completed" } } });
  } else if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { status: "interrupted" } } });
  }
});
