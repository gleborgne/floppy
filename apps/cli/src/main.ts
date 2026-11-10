#!/usr/bin/env node
// CLI `floppy`.
//   floppy start [--config floppy.yml] [--headless]   démarre le noyau (sans interface pour l'instant)
//   floppy plugins                                       état de chaque entrée de la config
//   floppy log [n]                                       journal d'audit
//   floppy approvals                                     demandes d'accord en attente
//   floppy approve <id> [--no]                           répondre à une demande
//   floppy restart <id>                                  relancer une entrée
//   floppy reload                                        relire la config
//   floppy settings                                      réglages (voix, écoute…) et leur valeur
//   floppy set <clé> <valeur>                             changer un réglage (même ceux interdits à la voix)
//   floppy undo                                          annuler le dernier changement de réglage
//   floppy chat                                          corps texte : parler à Floppy au clavier (comme Telegram)
//   floppy tool <outil> ['{"json"}']                     appelle un outil (accord demandé dans ce terminal)
//   floppy migrate [--apply] [--force]                   met à niveau les fichiers de l'utilisateur (à blanc par défaut)
//   floppy dev <dossier> [--home d] [--inspect]          mode debug : Floppy + ce plugin, rechargé à chaque sauvegarde
//   floppy plugin new <id> | check <d> | test <d>        écrire un plugin
//   floppy plugin install <source> | list | approve <id> | remove <id>   plugins tiers
// Option commune : --home <dossier> (dossier de données ; celui d'un `floppy dev` pour lui parler).
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { controlCall, errorText, findExe, floppyHome, gbText, machineSummary, probeMachine, tr, type EntryStatus, type MachineInfo, type Text } from "@floppy/core";
import { boot } from "./boot.ts";
import { checkPlugin, formatFindings } from "./plugins/check.ts";
import { newPlugin } from "./plugins/scaffold.ts";
import { installKey } from "./plugins/store.ts";
import { loadPluginDir, throwawayTest } from "./user-plugins.ts";
import { chat } from "./chat.ts";
import { migrateCommand } from "./migrate.ts";
import { cliLang, sayer } from "./lang.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    headless: { type: "boolean", default: false },
    no: { type: "boolean", default: false },
    home: { type: "string" },
    inspect: { type: "boolean", default: false },
    dir: { type: "string" },
    apply: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});
const [cmd = "help", ...rest] = positionals;
// Mode debug : un dossier de données à part (dans le dossier du plugin), sauf --home ou FLOPPY_HOME.
if (values.home) process.env.FLOPPY_HOME = resolve(values.home);
else if (cmd === "dev" && rest[0] && !process.env.FLOPPY_HOME) process.env.FLOPPY_HOME = join(resolve(rest[0]), ".floppy-dev");
const home = floppyHome();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Langue de l'interface (réglage langue_interface) : les messages propres à la CLI. */
const lang = cliLang(home);
const say = sayer(lang);

const ICON: Record<string, string> = { active: "●", waiting: "◌", error: "✖", disabled: "–", loaded: "○", starting: "…", stopping: "…" };

async function main(): Promise<number> {
  switch (cmd) {
    case "start": {
      const running = await boot(values.config ? { configPath: values.config } : {});
      // Nouveau répertoire de travail choisi : Floppy s'arrête, il repart dans ce dossier au prochain lancement.
      running.kernel.bus.on("floppy.restart", () => {
        console.log("\n" + say("Nouveau répertoire de travail : relance Floppy pour l'utiliser.", "New working folder: start Floppy again to use it."));
        void running.stop().then(() => process.exit(0));
      });
      printStatus(running.kernel.status());
      console.log("\n" + say(`Noyau prêt (dossier : ${home}). Ctrl+C pour arrêter.`, `Kernel ready (folder: ${home}). Ctrl+C to stop.`));
      running.kernel.bus.on("plugin.state", (s) => {
        if (s.state === "error" || s.state === "waiting") console.log(`${ICON[s.state]} ${s.id}${say(" : ", ": ")}${s.error ?? say(`attend ${s.missing?.join(", ")}`, `waiting for ${s.missing?.join(", ")}`)}`);
      });
      const stop = async () => {
        try { await running.stop(); } catch (e) { console.error(say("Arrêt : ", "Stop: ") + tr(errorText(e), lang)); process.exit(1); }
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return await new Promise<number>(() => {});
    }
    case "plugins": {
      const { data } = await controlCall(home, "GET", "/status");
      printStatus(data.plugins);
      return data.plugins.some((p: EntryStatus) => p.state === "error") ? 1 : 0;
    }
    case "log": {
      const { data } = await controlCall(home, "GET", `/log?n=${Number(rest[0] ?? 30)}`);
      for (const r of data) console.log(JSON.stringify(r));
      return 0;
    }
    case "approvals": {
      const { data } = await controlCall(home, "GET", "/approvals");
      if (!data.length) console.log(say("Aucune demande en attente.", "No pending requests."));
      for (const r of data) console.log(`${r.id}  ${r.level.padEnd(6)} ${r.tool}  ${say(`« ${tr(r.summary, lang)} »`, `"${tr(r.summary, lang)}"`)}`);
      return 0;
    }
    case "approve": {
      if (!rest[0]) throw new Error(say("usage : floppy approve <id> [--no]", "usage: floppy approve <id> [--no]"));
      const { status } = await controlCall(home, "POST", "/approve", { id: rest[0], ok: !values.no });
      console.log(status === 200 ? (values.no ? say("Refusé.", "Refused.") : say("Accordé.", "Approved.")) : say("Demande inconnue ou expirée.", "Unknown or expired request."));
      return status === 200 ? 0 : 1;
    }
    case "restart": {
      if (!rest[0]) throw new Error(say("usage : floppy restart <id>", "usage: floppy restart <id>"));
      const { status, data } = await controlCall(home, "POST", "/restart", { id: rest[0] });
      if (status !== 200) { console.log(tr(data.text ?? data.error, lang)); return 1; }
      console.log(say("Relancé.", "Restarted."));
      return 0;
    }
    case "reload": {
      const { status, data } = await controlCall(home, "POST", "/reload");
      console.log(status === 200 ? say("Config relue.", "Config reloaded.") : status === 501 ? say("Pas de fichier de config.", "No config file.") : tr(data.text ?? data.error, lang));
      return status === 200 ? 0 : 1;
    }
    case "settings": {
      const { data } = await controlCall(home, "GET", "/settings");
      for (const r of data) {
        const label = r.type === "enum" ? r.options?.find((o: { value: string }) => o.value === r.value)?.label ?? r.value
          : r.type === "boolean" ? (r.value ? say("oui", "yes") : say("non", "no")) : r.value;
        const choices = r.type === "enum" ? r.options.map((o: { value: string }) => o.value).join(" | ") : r.type === "number" ? `${r.min}..${r.max}` : r.type === "text" ? say("texte libre", "free text") : say("oui | non", "yes | no");
        console.log(`${r.key.padEnd(14)} ${(label && typeof label === "object" ? tr(label, lang) : String(label)).padEnd(28)} [${r.risk}]  ${choices}`);
      }
      return 0;
    }
    case "set": {
      if (!rest[0] || rest[1] === undefined) throw new Error(say("usage : floppy set <clé> <valeur>", "usage: floppy set <key> <value>"));
      const { data } = await controlCall(home, "POST", "/settings", { key: rest[0], value: rest.slice(1).join(" ") });
      console.log(data.text);
      return data.ok ? 0 : 1;
    }
    case "undo": {
      const { data } = await controlCall(home, "POST", "/settings/undo");
      console.log(data.text);
      return data.ok ? 0 : 1;
    }
    case "chat":
      return await chat(home, lang);
    case "tool": {
      if (!rest[0]) throw new Error(say("usage : floppy tool <outil> ['{\"param\":\"valeur\"}']", "usage: floppy tool <tool> ['{\"param\":\"value\"}']"));
      let args: unknown = {};
      try { args = rest[1] ? JSON.parse(rest.slice(1).join(" ")) : {}; } catch { throw new Error(say("paramètres : un objet JSON est attendu", "parameters: a JSON object is expected")); }
      const r = await callTool(rest[0], args as Record<string, unknown>);
      console.log(`[${r.status}] ${tr(r.text as never, lang)}`);
      return r.status === "done" || r.status === "unverified" ? 0 : 1;
    }
    case "machine": return await machine();
    case "migrate": {
      const r = migrateCommand(home, { apply: values.apply, force: values.force }, say);
      console.log(r.lines.join("\n"));
      return r.code;
    }
    case "dev": return await dev();
    case "plugin": return await plugin();
    default:
      console.log(say(
        "Commandes : start [--config f] [--headless] | machine | migrate [--apply] [--force] | chat | settings | set <clé> <valeur> | undo | plugins | log [n] | approvals | approve <id> [--no] | restart <id> | reload | tool <outil> [json] | dev <dossier> [--inspect] | plugin new|check|test|install|list|approve|remove … | option --home <dossier>",
        "Commands: start [--config f] [--headless] | machine | migrate [--apply] [--force] | chat | settings | set <key> <value> | undo | plugins | log [n] | approvals | approve <id> [--no] | restart <id> | reload | tool <tool> [json] | dev <folder> [--inspect] | plugin new|check|test|install|list|approve|remove … | option --home <folder>",
      ));
      return cmd === "help" ? 0 : 1;
  }
}

/** `floppy machine` : ce que Floppy lit de la machine ; avec le noyau qui tourne, les niveaux du premier lancement aussi. */
async function machine(): Promise<number> {
  let plan: { machine: MachineInfo; levels: { id: string; label: Text; possible: boolean; reason?: Text; picks: { label: Text }[] }[]; recommended: string; agents: { label: Text; program: string; found: boolean }[] } | undefined;
  try {
    const r = await controlCall(home, "GET", "/onboarding");
    if (r.status === 200) plan = r.data;
  } catch { /* noyau arrêté : la machine seule */ }
  const m = plan?.machine ?? await probeMachine({ ...(findExe("llama-server") ? { llamaExe: findExe("llama-server")! } : {}) });
  console.log(tr(machineSummary(m), lang));
  for (const g of m.gpus) {
    const mem = g.totalBytes ? ` · ${tr(gbText(g.totalBytes), lang)}` : "";
    const free = g.freeBytes ? say(` · ${tr(gbText(g.freeBytes), lang)} libres`, ` · ${tr(gbText(g.freeBytes), lang)} free`) : "";
    console.log(`  ${g === m.gpu ? "●" : "○"} ${g.name}${g.integrated ? say(" (intégrée)", " (integrated)") : ""}${mem}${free} · ${g.backends.join(", ")}`);
  }
  console.log(say(`Sondes : ${m.sources.join(", ") || "aucune"}`, `Probes: ${m.sources.join(", ") || "none"}`));
  const agents = plan?.agents ?? [["Claude Code", "claude"], ["Codex", "codex"], ["Antigravity", "agy"]].map(([label, program]) => ({ label: label!, program: program!, found: !!findExe(program!) }));
  console.log(say("Programmes de cerveau :", "Brain programs:"));
  for (const a of agents) console.log(`  ${a.found ? "●" : "○"} ${tr(a.label, lang)} (${a.program})${a.found ? "" : say(" : pas installé", ": not installed")}`);
  if (!plan) { console.log(say("Niveaux : lancez d'abord le noyau (floppy start).", "Levels: start the kernel first (floppy start).")); return 0; }
  console.log(say("Niveaux :", "Levels:"));
  for (const l of plan.levels) {
    const mark = l.id === plan.recommended ? "★" : l.possible ? "●" : "✖";
    const detail = l.possible ? l.picks.map((p) => tr(p.label, lang)).join(" · ") : tr(l.reason ?? "", lang);
    console.log(`  ${mark} ${tr(l.label, lang)} — ${detail}`);
  }
  return 0;
}

/**
 * Appelle un outil du noyau qui tourne. Une demande d'accord de cet outil est posée ici, dans le terminal
 * (c'est l'utilisateur lui-même qui tape la commande ; l'accord reste celui du noyau, journalisé).
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ status: string; text: unknown }> {
  const before = new Set<string>(((await controlCall(home, "GET", "/approvals")).data as { id: string }[]).map((r) => r.id));
  let done = false;
  const call = controlCall(home, "POST", "/tool", { name, args }).finally(() => { done = true; });
  const asked = new Set<string>();
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    while (!done) {
      await Promise.race([call.catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      if (done) break;
      const { data } = await controlCall(home, "GET", "/approvals");
      for (const r of data as { id: string; tool: string; summary: unknown }[]) {
        if (before.has(r.id) || asked.has(r.id) || r.tool !== name) continue;
        asked.add(r.id);
        if (!rl) { console.log(say(`Accord demandé : floppy approve ${r.id}`, `Approval needed: floppy approve ${r.id}`)); continue; }
        const a = (await rl.question(say(`Autoriser « ${tr(r.summary as never, lang)} » ? (o/n) `, `Allow "${tr(r.summary as never, lang)}"? (y/n) `))).trim().toLowerCase();
        await controlCall(home, "POST", "/approve", { id: r.id, ok: ["o", "oui", "y", "yes"].includes(a) });
      }
    }
  } finally { rl?.close(); }
  const { status, data } = await call;
  if (status !== 200) throw new Error(tr(data.text ?? data.error, lang));
  return data;
}

/** Config du mode debug : --config, ./floppy.yml, celle du dépôt de Floppy, sinon une config vide. */
function devConfig(): string {
  for (const p of [values.config, "floppy.yml", join(ROOT, "floppy.yml")]) if (p && existsSync(p)) return resolve(p);
  const empty = join(home, "floppy.yml");
  if (!existsSync(empty)) writeFileSync(empty, "plugins: []\n", "utf8");
  return empty;
}

async function dev(): Promise<number> {
  const dir = rest[0];
  if (!dir || !existsSync(dir)) throw new Error(say("usage : floppy dev <dossier du plugin> [--home d] [--inspect] [--config f]", "usage: floppy dev <plugin folder> [--home d] [--inspect] [--config f]"));
  if (values.inspect) {
    console.log(say("Débogueur : le plugin tourne SANS l'isolation des fichiers (Node ne permet pas les deux). Ouvre chrome://inspect ou « Attach » dans VS Code.",
      "Debugger: the plugin runs WITHOUT file isolation (Node does not allow both). Open chrome://inspect or \"Attach\" in VS Code."));
  }
  const configPath = devConfig();
  const running = await boot({ configPath, devDirs: [resolve(dir)], ...(values.inspect ? { sandbox: { inspect: true } } : {}) });
  printStatus(running.kernel.status());
  const tools = running.kernel.tools.list().filter((t) => t.source.startsWith("u-"));
  console.log("\n" + say(`Mode debug — données : ${home}\nConfig : ${configPath}`, `Debug mode — data: ${home}\nConfig: ${configPath}`));
  if (tools.length) console.log(say("Outils du plugin : ", "Plugin tools: ") + tools.map((t) => `${t.name} [${t.level}]`).join(", "));
  console.log(say(`Dans un autre terminal :\n  floppy tool <outil> '{…}' --home "${home}"\n  floppy chat --home "${home}"\nChaque sauvegarde recharge le plugin. Ctrl+C pour arrêter.`,
    `In another terminal:\n  floppy tool <tool> '{…}' --home "${home}"\n  floppy chat --home "${home}"\nEach save reloads the plugin. Ctrl+C to stop.`));
  running.kernel.bus.on("plugin.state", (s) => {
    if (!s.id.startsWith("u-")) return;
    console.log(`${ICON[s.state] ?? "?"} ${s.id} ${s.state}${s.error ? " — " + tr(s.error, lang) : ""}`);
  });
  const stop = async () => { try { await running.stop(); } finally { process.exit(0); } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return await new Promise<number>(() => {});
}

async function plugin(): Promise<number> {
  const [sub, arg] = rest;
  const need = (usage: string): string => { if (!arg) throw new Error(say(`usage : floppy plugin ${usage}`, `usage: floppy plugin ${usage}`)); return arg; };
  switch (sub) {
    case "new": {
      const dir = newPlugin(need("new <id> [--dir dossier]"), values.dir ?? ".");
      console.log(say(`Plugin créé : ${dir}\nEnsuite : floppy dev "${dir}"`, `Plugin created: ${dir}\nNext: floppy dev "${dir}"`));
      return 0;
    }
    case "check": {
      const r = checkPlugin(resolve(need("check <dossier>")));
      for (const l of formatFindings(r.findings, lang)) console.log(l);
      console.log(r.ok ? say(`OK — ${r.files.length} fichiers, empreinte ${r.hash.slice(0, 16)}`, `OK — ${r.files.length} files, hash ${r.hash.slice(0, 16)}`) : say("BLOQUÉ : à corriger avant de publier.", "BLOCKED: fix this before publishing."));
      return r.ok ? 0 : 1;
    }
    case "test": {
      const { id, def } = await loadPluginDir(need("test <dossier>"));
      const r = await throwawayTest(def, id);
      console.log(`${r.ok ? "OK" : say("PROBLÈME", "PROBLEM")} ${id}${r.state ? ` (${r.state})` : ""}${r.error ? " — " + r.error : ""}`);
      console.log(say("Outils : ", "Tools: ") + (r.tools.map((t) => `${t.name} [${t.level}]`).join(", ") || "-"));
      console.log(say("Réglages : ", "Settings: ") + (r.settings.map((s) => `${s.key} [${s.risk}]`).join(", ") || "-"));
      for (const l of r.logs) console.log("  " + l);
      return r.ok ? 0 : 1;
    }
    case "install": {
      const src = need("install <dossier | fichier.zip | https://…zip | dépôt git[#ref]>");
      // Chemin local : rendu absolu ici, le noyau n'a pas le même dossier courant que ce terminal.
      const r = await callTool("installer_plugin", { source: /^[a-z+]+:\/\//i.test(src) || !existsSync(src.split("#")[0]!) ? src : resolve(src) });
      console.log(tr(r.text as never, lang));
      return r.status === "done" ? 0 : 1;
    }
    case "list": {
      const r = await callTool("plugins_tiers", {});
      console.log(tr(r.text as never, lang));
      return 0;
    }
    case "approve": {
      const id = need("approve <id>");
      const { data } = await controlCall(home, "POST", "/settings", { key: installKey(id), value: true });
      const key = "plugin_" + id.replaceAll("-", "_");
      console.log(data.ok ? say(`Installé : ${id}. Active-le dans la fenêtre des réglages, ou : floppy set ${key} oui`, `Installed: ${id}. Turn it on in the Settings window, or: floppy set ${key} yes`) : tr(data.text, lang));
      return data.ok ? 0 : 1;
    }
    case "remove": {
      const r = await callTool("desinstaller_plugin", { id: need("remove <id>") });
      console.log(tr(r.text as never, lang));
      return r.status === "done" ? 0 : 1;
    }
    default:
      console.log(say("usage : floppy plugin new <id> | check <dossier> | test <dossier> | install <source> | list | approve <id> | remove <id>",
        "usage: floppy plugin new <id> | check <folder> | test <folder> | install <source> | list | approve <id> | remove <id>"));
      return sub ? 1 : 0;
  }
}

function printStatus(list: EntryStatus[]): void {
  if (!list.length) console.log(say("(aucune entrée dans la config)", "(no entries in the config)"));
  for (const p of list) {
    const extra = p.error ?? (p.missing ? say(`attend : ${p.missing.join(", ")}`, `waiting for: ${p.missing.join(", ")}`) : p.provides.length ? say(`fournit : ${p.provides.join(", ")}`, `provides: ${p.provides.join(", ")}`) : "");
    console.log(`${ICON[p.state] ?? "?"} ${p.id.padEnd(10)} ${p.plugin.padEnd(18)} ${p.state.padEnd(9)} ${extra}`);
  }
}

main().then((code) => process.exit(code), (e: unknown) => { console.error(tr(errorText(e), lang)); process.exit(1); });
