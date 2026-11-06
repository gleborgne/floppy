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
import { parseArgs } from "node:util";
import { controlCall, errorText, floppyHome, tr, type EntryStatus } from "@floppy/core";
import { boot } from "./boot.ts";
import { chat } from "./chat.ts";
import { cliLang, sayer } from "./lang.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c", default: "floppy.yml" },
    headless: { type: "boolean", default: false },
    no: { type: "boolean", default: false },
  },
});
const [cmd = "help", ...rest] = positionals;
const home = floppyHome();
/** Langue de l'interface (réglage langue_interface) : les messages propres à la CLI. */
const lang = cliLang(home);
const say = sayer(lang);

const ICON: Record<string, string> = { active: "●", waiting: "◌", error: "✖", disabled: "–", loaded: "○", starting: "…", stopping: "…" };

async function main(): Promise<number> {
  switch (cmd) {
    case "start": {
      const running = await boot({ configPath: values.config });
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
    default:
      console.log(say(
        "Commandes : start [--config f] [--headless] | chat | settings | set <clé> <valeur> | undo | plugins | log [n] | approvals | approve <id> [--no] | restart <id> | reload",
        "Commands: start [--config f] [--headless] | chat | settings | set <key> <value> | undo | plugins | log [n] | approvals | approve <id> [--no] | restart <id> | reload",
      ));
      return cmd === "help" ? 0 : 1;
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
