// Une consigne vise un agent précis, figé avant l'accord puis revérifié avant l'envoi.
import { T, TextError, type Context, type ToolCallInput, type ToolDef, type ToolOutput, type ToolResult } from "@floppy/core";
import type { Hit, OrcaCli, OrcaRunner, OrcaTerminal } from "./index.ts";
import { isWorker } from "./speech.ts";

interface SendDeps {
  ctx: Context;
  cli: OrcaCli;
  run: OrcaRunner;
  direct: () => boolean;
  target: (wts: Awaited<ReturnType<OrcaRunner>>, nom: string) => Hit | ToolOutput;
}
interface Prepared { worktreeId: string; paneKey: string; terminal: string; label: string; message: string }

export function sendTool({ ctx, cli, run, direct, target }: SendDeps): ToolDef {
  const prepared = new WeakMap<Record<string, unknown>, Prepared>();
  const missing = () => new TextError(T("Cet agent n'a plus de terminal identifiable dans Orca. Aucun message envoyé.", "This agent no longer has an identifiable terminal in Orca. No message sent."));
  const terminal = async (worktreeId: string, paneKey: string): Promise<string> => {
    const r = await cli(["terminal", "list"]) as { terminals?: OrcaTerminal[] } | undefined;
    // Aucun repli vers un autre terminal du projet : il pourrait s'agir d'un shell ou d'un autre agent.
    const matches = (r?.terminals ?? []).filter((t) => t.worktreeId === worktreeId && `${t.tabId}:${t.leafId}` === paneKey && /^term_[A-Za-z0-9-]{1,80}$/.test(t.handle));
    if (matches.length !== 1) throw missing();
    return matches[0]!.handle;
  };

  ctx.hook<ToolCallInput, ToolResult>("tool.before", async (input, next) => {
    if (input.name !== "orca_envoyer" || input.tool.source !== ctx.id) return next(input);
    const message = typeof input.args.message === "string" ? input.args.message.trim() : "";
    if (!message || message.length > 4000 || /^[\-]/.test(message) || /[\x00-\x1f\x7f]/.test(message)) {
      throw new TextError(T("Donne une consigne sur une seule ligne, de 1 à 4 000 caractères, sans tiret au début.", "Give an instruction on one line, between 1 and 4,000 characters, without a leading hyphen."));
    }
    if (!direct()) throw new TextError(T("Envoi impossible : règle le chemin vers le programme Orca, sans script intermédiaire.", "Cannot send: set the path to the Orca program, without an intermediate script."));
    const hit = target(await run(), String(input.args.nom ?? ""));
    if (!("a" in hit)) throw new TextError(hit.text);
    if (isWorker(hit.a)) throw new TextError(T("Cet agent est piloté par un coordinateur. Adresse la consigne à son coordinateur.", "This agent is managed by a coordinator. Send the instruction to its coordinator."));
    const p: Prepared = {
      worktreeId: hit.w.worktreeId, paneKey: hit.a.paneKey,
      terminal: await terminal(hit.w.worktreeId, hit.a.paneKey),
      label: hit.w.displayName || hit.w.repo || hit.w.worktreeId, message,
    };
    // Arguments propres à cet appel : deux accords simultanés ne partagent jamais leur cible.
    const args = { ...input.args };
    prepared.set(args, p);
    try { return await next({ ...input, args }); }
    finally { prepared.delete(args); }
  });

  return {
    name: "orca_envoyer",
    description: "Envoie une consigne à un agent de code Orca déjà ouvert, après l'accord de l'utilisateur. À utiliser pour « dis-lui de commit », « demande-lui de corriger les tests », « dis-lui de continuer ». message : la consigne demandée par l'utilisateur, sur une seule ligne. nom : projet ou tâche tel que dicté ; omettre pour l'agent annoncé en dernier, sinon le seul qui attend. Si plusieurs agents correspondent, demander lequel. Ne pas utiliser pour valider un menu de permissions ni pour piloter un worker d'orchestration. Un envoi accepté ne prouve pas que la tâche est faite ; ne pas renvoyer automatiquement.",
    inputSchema: { type: "object", properties: { nom: { type: "string" }, message: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["message"] },
    level: "send",
    summary: (args) => {
      const p = prepared.get(args)!;
      return T(`Envoyer à l'agent de ${p.label} : « ${p.message} » ?`, `Send to the agent in ${p.label}: “${p.message}”?`);
    },
    handler: async (args, meta) => {
      const p = prepared.get(args);
      if (!p) throw missing();
      const wts = await run();
      if (!wts.some((w) => w.worktreeId === p.worktreeId && w.agents?.some((a) => a.paneKey === p.paneKey && !isWorker(a)))) throw missing();
      if (await terminal(p.worktreeId, p.paneKey) !== p.terminal) throw missing();
      meta.signal?.throwIfAborted();
      try {
        const r = await cli(["terminal", "send", "--terminal", p.terminal, "--text", p.message, "--enter"]) as { accepted?: boolean } | undefined;
        if (r?.accepted === true) return { status: "done", text: T(`Consigne transmise à l'agent de ${p.label}. Cela ne confirme pas qu'il l'a exécutée.`, `Instruction sent to the agent in ${p.label}. This does not confirm it has carried it out.`) };
        if (r?.accepted === false) return { status: "failed", text: T("Orca a refusé la consigne. Aucun nouvel envoi effectué.", "Orca refused the instruction. No further send attempted.") };
      } catch { /* Une erreur de transport peut survenir après l'acceptation : ne jamais renvoyer. */ }
      return { status: "unverified", text: T("Je n'ai pas pu confirmer l'envoi à Orca. Vérifie l'agent avant de réessayer : il a peut-être reçu la consigne.", "I could not confirm delivery to Orca. Check the agent before retrying: it may have received the instruction.") };
    },
  };
}
