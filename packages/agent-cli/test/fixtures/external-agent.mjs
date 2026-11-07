// Faux agents : les formes de flux viennent des protocoles officiels, aucun fournisseur réseau.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
const [protocol, ...args] = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const value = (flag) => args[args.indexOf(flag) + 1];
const snapshot = () => ({ args, cwd: process.cwd(), env: {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  FLOPPY_MCP_TOKEN: process.env.FLOPPY_MCP_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDECODE: process.env.CLAUDECODE,
  HERMES_HOME: process.env.HERMES_HOME,
}, config: protocol === "opencode" ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)
  : JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? process.env.HERMES_HOME,
    protocol === "hermes" ? "config.yaml" : "mcp.json"), "utf8")),
  system: args.includes("--system-prompt") ? readFileSync(value("--system-prompt"), "utf8") : undefined });

if (protocol === "hermes") {
  const descriptor = join(process.env.HERMES_HOME, "fake-gateway.json");
  if (args[1] === "attach") {
    try { emit(JSON.parse(readFileSync(descriptor, "utf8"))); } catch { process.exitCode = 1; }
  } else {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: (protocols) => protocols.has("hermes-gateway-v1") ? "hermes-gateway-v1" : false });
    wss.on("listening", () => writeFileSync(descriptor, JSON.stringify({ state: "ready", endpoint: { control_home: process.env.HERMES_HOME },
      url: `ws://127.0.0.1:${wss.address().port}`, protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.fake-secret"] })));
    wss.on("connection", (socket) => {
      const send = (obj) => socket.send(JSON.stringify(obj));
      const event = (type, payload, admission_id = "admit") => send({ jsonrpc: "2.0", method: "event", params: { type, payload, admission_id, session_id: "sid", execution_generation: 1 } });
      socket.on("message", (data) => {
        const r = JSON.parse(String(data));
        if (r.method === "runtime.describe") send({ id: r.id, result: { session_create: { sources: ["oneshot"], parameters: ["cwd", "model", "provider", "toolsets", "ignore_rules", "max_turns"] } } });
        if (r.method === "session.create") { socket.floppyModel = r.params.model; send({ id: r.id, result: { session_id: "sid", stored_session_id: "sid", execution_generation: 1 } }); }
        if (r.method === "prompt.submit") {
          const text = r.params.text;
          if (text.includes("HANG")) { send({ id: r.id, result: { admission_id: "admit" } }); return; }
          if (text.includes("DROP")) { socket.close(); return; }
          if (text.includes("BADJSON")) { socket.send("invalide"); return; }
          if (text.includes("REPLAYGAP")) { event("session.replay_gap", {}); return; }
          if (text.includes("APPROVAL")) { event("approval.request", {}, null); return; }
          if (text.includes("BADTOOL")) { event("tool.start", { tool_name: "terminal", args: {} }); return; }
          // Des événements peuvent précéder l'accusé de réception ; ceux d'une autre admission sont ignorés.
          event("message.delta", { text: "ne pas lire" }, "other");
          event("message.delta", { text: JSON.stringify({ ...snapshot(), model: socket.floppyModel, prompt: text }) });
          send({ id: r.id, result: { admission_id: "admit", execution_generation: 1 } });
          event("message.complete", { outcome: text.includes("FAIL") ? "failed" : "completed", status: text.includes("FAIL") || text.includes("WRONGSTATUS") ? "error" : "complete", text: null });
        }
      });
    });
  }
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  if (prompt.includes("HANG")) {
    setInterval(() => {}, 1000);
  } else if (prompt.includes("BROKEN")) {
    process.stdout.write("pas du JSON\n");
  } else if (prompt.includes("CRASH")) {
    process.stderr.write("erreur " + process.env.OPENAI_API_KEY); process.exitCode = 1;
  } else {
    const text = JSON.stringify({ ...snapshot(), prompt });
    if (protocol === "opencode") {
      emit({ type: "step_start" });
      if (prompt.includes("TOOL")) emit({ type: "tool_use", part: { tool: prompt.includes("BADTOOL") ? "shell" : "floppy_agenda", state: { input: { x: 1 }, status: "completed" } } });
      emit({ type: "text", part: { text } });
      if (!prompt.includes("INCOMPLETE")) emit({ type: "step_finish", part: { reason: "stop" } });
      if (prompt.includes("FAIL")) emit({ type: "error", error: { message: "échec simulé" } });
    } else {
      if (prompt.includes("TOOL")) emit({ type: "tool_execution_start", toolName: prompt.includes("BADTOOL") ? "bash" : protocol === "pi" ? "mcp__floppy__agenda" : "mcp__floppy_agenda", args: { x: 1 } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      if (!prompt.includes("INCOMPLETE")) emit({ type: "message_end", message: { role: "assistant", stopReason: prompt.includes("FAIL") ? "error" : "stop", errorMessage: "échec simulé", content: [{ type: "text", text }] } });
    }
  }
}
