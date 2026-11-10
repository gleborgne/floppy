// Essai réel de l'assistant IA (plugin coder) avec le vrai CLI Claude, dans un noyau jetable.
//   node spikes/coder-live/run.ts
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, type CoderEvent, type CoderService } from "@floppy/core";
import tools from "@floppy/plugin-tools";
import coder from "@floppy/plugin-coder";
import { createUserPlugins } from "../../apps/cli/src/user-plugins.ts";

const home = mkdtempSync(join(tmpdir(), "coder-live-"));
const k = new Kernel({ home, plugins: [tools, coder], logger: ({ level, source, msg }) => { if (level !== "debug") console.log(`  [${source}] ${msg}`); } });
const up = createUserPlugins(k, { builtin: ["tools", "coder"] });
await k.applyConfig({ approvals: { timeout_s: 60 }, plugins: [{ id: "tools", plugin: "tools", config: { port: 0 } }, { id: "coder", plugin: "coder" }] });
await up.reload(false);
k.bus.on("approval.request", (r) => { console.log(`  [accord demandé] ${r.summary} → oui`); k.approvals.respond(r.id, true, "essai"); });
const c = k.service<CoderService>("coder")!;
console.log("CLI disponibles :", await c.available());

async function turn(sid: string, text: string, autoAllow: boolean): Promise<void> {
  console.log(`\n>>> ${text}`);
  await new Promise<void>((done) => {
    let line = "";
    const off = c.onEvent((e: CoderEvent) => {
      if (e.sessionId !== sid) return;
      if (e.type === "text") { line += e.delta; }
      else if (e.type === "tool") console.log(`  [outil] ${e.name} ${e.status}${e.output ? " → " + e.output.slice(0, 120).replace(/\s+/g, " ") : ""}`);
      else if (e.type === "permission") { console.log(`  [validation] ${e.description}${e.diff ? " (" + e.diff.path + ")" : ""} → ${autoAllow ? "autorisé" : "refusé"}`); c.answerPermission(sid, e.id, autoAllow); }
      else if (e.type === "done") { console.log(`<<< ${line.trim().slice(0, 600)}\n  [fin] ${e.stopReason}${e.error ? " : " + e.error : ""}${e.signIn ? " (connexion requise)" : ""}`); off(); done(); }
    });
    c.send(sid, text);
  });
}

const s1 = await c.start({ agent: "claude", mode: "reglages" });
await turn(s1, "Liste mes réglages en deux phrases.", false);
await turn(s1, "Passe le modèle Claude de l'assistant sur haiku.", false);
console.log("réglage assistant_claude_model =", k.settings.value("assistant_claude_model"));
c.close(s1);

const s2 = await c.start({ agent: "claude", mode: "plugin" });
await turn(s2, "Crée un plugin « salut » avec un seul outil dire_bonjour (niveau read) qui répond « Bonjour ! ». Puis teste-le avec tester_plugin.", true);
const f = join(home, "plugins", "salut", "index.ts");
console.log("\nfichier créé :", existsSync(f), existsSync(f) ? "\n" + readFileSync(f, "utf8").slice(0, 700) : "");
c.close(s2);
await k.stopAll();
process.exit(0);
