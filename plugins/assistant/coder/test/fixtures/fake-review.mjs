// Faux CLI de relecture : répond selon les arguments (claude -p, codex exec, agy stream-json).
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const answer = (prompt) => JSON.stringify({ verdict: "ok", summary: "lu " + prompt.length + " caractères", args });
if (args[0] === "exec") {
  let s = ""; process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => { writeFileSync(args[args.indexOf("-o") + 1], answer(s)); });
} else if (args.includes("stream-json")) {
  createInterface({ input: process.stdin }).on("line", (l) => {
    const m = JSON.parse(l);
    const text = answer(m.message.content);
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: text } }) + "\n");
    process.stdout.write(JSON.stringify({ event: "result", result: { status: "ok" } }) + "\n");
  });
} else {
  let s = ""; process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => {
    if (s.includes("ÉCHEC")) { process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "quota" })); return; }
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: answer(s) }));
  });
}
