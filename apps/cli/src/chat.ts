// `floppy chat` : un corps texte en ligne de commande, branché par le WebSocket des corps (plugin body-ws).
// Il joue le rôle d'un corps distant comme Telegram : les réponses reviennent ici, en texte, jamais à voix haute.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { T, TextError, tr } from "@floppy/core";
import { sayer } from "./lang.ts";

/** Message du corps WebSocket : un objet JSON, sinon rien (jamais d'exception). */
export function parseEvent(data: string): any | undefined {
  try {
    const ev = JSON.parse(data);
    return ev && typeof ev === "object" ? ev : undefined;
  } catch { return undefined; }
}

/** Réponse à une demande d'accord : « o/oui/n/non » (français) ou « y/yes/n/no » (anglais). undefined : pas une réponse. */
export function parseAnswer(t: string): boolean | undefined {
  if (/^(o|oui|y|yes)$/i.test(t)) return true;
  if (/^(n|non|no)$/i.test(t)) return false;
  return undefined;
}

/** Demande d'accord visée par « o »/« n » : la dernière montrée. */
export function answerTarget(pending: string[]): string | undefined {
  return pending.pop();
}

/** Réponse à un choix dans une liste : le numéro (1..n) d'une option montrée. undefined : pas une réponse valide. */
export function parseChoice(t: string, optionIds: string[]): string | undefined {
  if (!/^\d{1,3}$/.test(t)) return undefined;
  return optionIds[Number(t) - 1];
}

export async function chat(home: string, lang = "fr"): Promise<number> {
  const say = sayer(lang);
  const file = join(home, "body-ws.json");
  if (!existsSync(file)) throw new TextError(T("pas de corps WebSocket actif (plugin body-ws) : lancez l'app ou floppy start", "no active WebSocket body (body-ws plugin): start the app or floppy start"));
  const { port, token } = JSON.parse(readFileSync(file, "utf8")) as { port: number; token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: say("toi > ", "you > ") });
  const pending: string[] = [];
  let line = "";
  /** Dernier choix dans une liste montré (les numéros tapés lui répondent). */
  let lastChoice: { id: string; options: string[] } | undefined;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", id: "chat", name: "Chat (terminal)", version: "0.1.0", capabilities: ["text", "approval", "choice"] }));
  };
  ws.onmessage = (m) => {
    if (typeof m.data !== "string") return;
    const ev = parseEvent(m.data);
    if (!ev) return; // message illisible : on l'ignore
    if (ev.type === "welcome") { console.log(say(`Branché à ${ev.assistant.name}. Tapez un message (Ctrl+C pour quitter).`, `Connected to ${ev.assistant.name}. Type a message (Ctrl+C to quit).`)); rl.prompt(); }
    else if (ev.type === "reply.delta") { if (!line) process.stdout.write(`\r${"floppy > "}`); line += ev.text; process.stdout.write(ev.text); }
    else if (ev.type === "reply.done") { process.stdout.write("\n"); line = ""; rl.prompt(); }
    else if (ev.type === "emotion") process.stdout.write(`\x1b[2m(${ev.emotion})\x1b[0m `);
    else if (ev.type === "approval.request") { pending.push(ev.id); console.log("\n" + say(`[accord] ${tr(ev.summary, lang)} — tapez « o » ou « n »`, `[approval] ${tr(ev.summary, lang)} — type "y" or "n"`)); rl.prompt(); }
    else if (ev.type === "approval.closed") { const i = pending.indexOf(ev.id); if (i >= 0) pending.splice(i, 1); }
    else if (ev.type === "choice.request") {
      const options = (Array.isArray(ev.options) ? ev.options : []) as { id: string; label: string; detail?: string }[];
      lastChoice = { id: ev.id, options: options.map((o) => o.id) };
      console.log("\n" + `[${say("choix", "choice")}] ${tr(ev.title, lang)}`);
      options.forEach((o, i) => console.log(`  ${i + 1}. ${tr(o.label, lang)}${o.detail ? ` — ${tr(o.detail, lang)}` : ""}`));
      console.log(say("Tapez le numéro de votre choix.", "Type the number of your choice."));
      rl.prompt();
    }
    else if (ev.type === "choice.closed") { if (lastChoice?.id === ev.id) lastChoice = undefined; }
    else if (ev.type === "error") console.log("\n" + say(`[erreur] ${tr(ev.text, lang)}`, `[error] ${tr(ev.text, lang)}`));
  };
  rl.on("line", (input) => {
    const t = input.trim();
    if (!t) return rl.prompt();
    const picked = lastChoice ? parseChoice(t, lastChoice.options) : undefined;
    if (lastChoice && picked !== undefined) {
      ws.send(JSON.stringify({ type: "choice.response", id: lastChoice.id, option: picked }));
      return;
    }
    const answer = pending.length ? parseAnswer(t) : undefined;
    if (answer !== undefined) {
      // « o » / « n » répond à la dernière demande montrée (celle que l'utilisateur vient de lire), pas à la plus ancienne.
      ws.send(JSON.stringify({ type: "approval.response", id: answerTarget(pending), ok: answer }));
      return;
    }
    ws.send(JSON.stringify({ type: "text", text: t }));
  });
  return await new Promise<number>((ok) => {
    ws.onclose = () => { console.log("\n" + say("Débranché.", "Disconnected.")); ok(0); };
    rl.on("close", () => { ws.close(); ok(0); });
  });
}
