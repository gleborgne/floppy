// Faux CLI Claude pour les tests : lit des lignes stream-json sur stdin et joue un scénario selon le texte reçu.
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const resume = arg("--resume");
const toolsArg = arg("--tools") ?? "";
const mcp = JSON.parse(arg("--mcp-config") ?? "{}").mcpServers?.floppy;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sid = resume ?? "sess-1";
let turns = 0;
let started = false;

const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const startText = () => out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
const result = (extra = {}) => out({ type: "result", subtype: "success", is_error: false, session_id: sid, ...extra });

async function callMcp(name, args) {
  const r = await fetch(mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${process.env.FLOPPY_MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  return j.result?.content?.[0]?.text ?? JSON.stringify(j);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (l) => {
  const msg = JSON.parse(l);
  const text = msg.message.content[0].text;
  turns++;
  if (!started) {
    started = true;
    out({ type: "system", subtype: "init", session_id: sid, tools: [...toolsArg.split(",").filter(Boolean), "mcp__floppy__lister_reglages"] });
  }
  if (text === "hello") {
    startText(); delta("Bon"); delta("jour");
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Bonjour" }] } });
    result();
  } else if (text === "tool") {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__floppy__lister_reglages", input: {} }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "voix : femme" }] } });
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "x" } }] } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "boum" }], is_error: true }] } });
    startText(); delta("fini");
    result();
  } else if (text === "info") {
    startText(); delta(`pid=${process.pid} tour=${turns} resume=${resume ?? "aucun"} args=${argv.join(" ")}`);
    result();
  } else if (text === "slow") {
    startText(); delta("début…");
    // ne termine jamais : le test annule
  } else if (text === "auth") {
    out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: sid });
  } else if (text.startsWith("perm:")) {
    const req = JSON.parse(text.slice(5));
    const r = JSON.parse(await callMcp("permission", { tool_name: req.tool_name, input: req.input, tool_use_id: "u1" }));
    startText(); delta(r.behavior === "allow" ? "autorisé" : `refusé : ${r.message}`);
    result();
  } else if (text === "outside-tool") {
    // Un outil Floppy hors de la portée : doit être refusé par le serveur MCP.
    const t = await callMcp("ecrire_note", {});
    startText(); delta(t);
    result();
  }
});
