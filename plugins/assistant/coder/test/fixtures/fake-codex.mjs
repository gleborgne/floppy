// Faux `codex app-server` pour les tests (JSON-RPC, une ligne JSON par message).
import { createInterface } from "node:readline";
import { join } from "node:path";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let cwd = process.cwd();
let waiting = new Map();
let nextServerId = 100;
const askServer = (method, params) => new Promise((ok) => { const id = nextServerId++; waiting.set(id, ok); out({ jsonrpc: "2.0", id, method, params }); });
const note = (method, params) => out({ jsonrpc: "2.0", method, params: { threadId: "th1", ...params } });

async function turn(text) {
  if (text.startsWith("patch")) {
    const path = text === "patch-outside" ? join(cwd, "..", "dehors.txt") : join(cwd, "mon-plugin", "index.ts");
    note("item/started", { item: { type: "fileChange", id: "f1", changes: [{ path, kind: { type: "add" }, diff: "+export default {};" }], status: "inProgress" } });
    const r = await askServer("item/fileChange/requestApproval", { threadId: "th1", turnId: "tu1", itemId: "f1" });
    note("item/completed", { item: { type: "fileChange", id: "f1", changes: [], status: r.decision === "accept" ? "completed" : "declined" } });
    note("item/agentMessage/delta", { itemId: "m1", delta: `decision=${r.decision}` });
  } else if (text === "auth") {
    note("error", { error: { message: "401 Unauthorized", codexErrorInfo: "unauthorized" } });
    note("turn/completed", { turn: { id: "tu1", status: "failed", error: { message: "401 Unauthorized" } } });
    return;
  } else {
    note("item/started", { item: { type: "mcpToolCall", id: "c1", server: "floppy", tool: "list_settings", arguments: {}, status: "inProgress" } });
    note("item/completed", { item: { type: "mcpToolCall", id: "c1", server: "floppy", tool: "list_settings", status: "completed", result: { content: [{ type: "text", text: "ok" }] } } });
    note("item/agentMessage/delta", { itemId: "m1", delta: "Salut" });
  }
  note("turn/completed", { turn: { id: "tu1", status: "completed", error: null } });
}

createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: {} });
  else if (m.method === "thread/start") {
    cwd = m.params.cwd;
    out({ jsonrpc: "2.0", id: m.id, result: { thread: { id: "th1" }, sandbox: m.params.sandbox, approvalPolicy: m.params.approvalPolicy } });
  } else if (m.method === "turn/start") {
    out({ jsonrpc: "2.0", id: m.id, result: { turn: { id: "tu1" } } });
    void turn(m.params.input[0].text);
  } else if (m.method === "turn/interrupt") {
    out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
