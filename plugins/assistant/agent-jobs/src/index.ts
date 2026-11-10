// Missions nommées : une délégation ponctuelle ou un travail suivi, sans changer le cerveau choisi.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { definePlugin, readJsonFile, writeJsonAtomic, T, TextError, tr, errorText, type Context } from "@floppy/core";
import { borrowAgent, validAgentModel } from "@floppy/agent-cli";
import type { AgentService } from "@floppy/contracts";

const Job = z.object({
  id: z.string(), agent: z.string(), model: z.string().optional(), instruction: z.string(),
  state: z.enum(["running", "done", "failed", "cancelled", "interrupted"]),
  started: z.string(), finished: z.string().optional(), result: z.string().optional(), document: z.string().optional(),
});
type Job = z.infer<typeof Job>;
const Config = z.object({ maxConcurrent: z.number().int().min(1).max(10).default(3), timeout_s: z.number().int().min(1).max(3600).default(600) });

export default definePlugin({
  manifest: {
    id: "agent-jobs", version: "0.1.0", licence: "MIT", description: "Délégation vers un agent nommé et travaux suivis.",
    optional: ["agent", "documents"], permissions: { "fs.write": ["workspaces/agent-jobs"] },
    addable: { section: "brain", label: T("Travaux des agents", "Agent tasks"), single: true,
      description: T("Confie une mission à un agent et retrouve son résultat. Les outils restent soumis aux accords de Floppy.",
        "Give an agent a task and retrieve its result. Tools remain subject to Floppy approvals.") },
  },
  config: Config,
  apply(ctx, cfg) {
    const file = join(ctx.workspace(), "jobs.json");
    const saved = z.array(Job).safeParse(readJsonFile(file) ?? []);
    if (!saved.success) throw new TextError(T("Le journal des travaux d'agent est invalide.", "The agent task journal is invalid."));
    const jobs = saved.data;
    // Une mission interrompue par l'arrêt de Floppy n'est jamais rejouée automatiquement.
    for (const j of jobs) if (j.state === "running") { j.state = "interrupted"; j.finished = new Date().toISOString(); }
    const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
    const save = () => writeJsonAtomic(file, jobs);
    if (jobs.length) save();
    ctx.effect(async () => {
      for (const r of running.values()) r.controller.abort();
      await Promise.allSettled([...running.values()].map((r) => r.done));
    });
    const failure = (fr: string, en: string) => ({ status: "failed" as const, text: T(fr, en) });
    const instruction = (a: Record<string, unknown>) => String(a.consigne ?? "").trim();
    const validate = (a: Record<string, unknown>) => instruction(a) && (!a.modele || validAgentModel(String(a.modele)));
    const execute = async (agent: AgentService, a: Record<string, unknown>, signal: AbortSignal, origin?: string, onTool?: (name: string) => void) => {
      if (!agent.run) throw new TextError(T("Cet agent propose seulement des sessions interactives.", "This agent only supports interactive sessions."));
      let result: string | undefined;
      for await (const ev of agent.run({ text: instruction(a), model: a.modele ? String(a.modele) : undefined,
        session: randomUUID(), origin, mode: "text", signal })) {
        signal.throwIfAborted();
        if (ev.type === "tool") onTool?.(ev.name);
        if (ev.type === "done") {
          if (ev.info?.error) throw new TextError(T("L'agent a signalé un échec.", "The agent reported a failure."));
          result = ev.text;
        }
      }
      signal.throwIfAborted();
      if (result === undefined) throw new TextError(T("L'agent n'a pas rendu de résultat final.", "The agent did not return a final result."));
      return result;
    };
    const schema = { type: "object", properties: {
      agent: { type: "string", description: "Identifiant complet de lister_agents, ou nom non ambigu." },
      modele: { type: "string", description: "Modèle demandé pour cette mission seulement." },
      consigne: { type: "string", description: "Consigne complète et autonome." },
    }, required: ["agent", "consigne"] };
    const summary = (a: Record<string, unknown>) => T(`Confier une mission à ${String(a.agent)}${a.modele ? ` (${String(a.modele)})` : ""} ?`, `Give a task to ${String(a.agent)}${a.modele ? ` (${String(a.modele)})` : ""}?`);
    ctx.tools.register([
      {
        name: "lister_agents", description: "Liste les agents ajoutés et disponibles, leurs identifiants, alias et usages pris en charge. Utilise ces identifiants pour une mission ou une session.",
        inputSchema: { type: "object", properties: {} }, level: "read",
        handler: async () => {
          const list = [];
          for (const o of ctx.offers("agent")) {
            const b = await ctx.borrowItem<AgentService>("agent", o.value);
            if (!b) continue;
            try { list.push({ id: o.value, label: b.service.label, aliases: b.service.aliases,
              interactive: true, delegation: !!b.service.run, tracked: !!b.service.run }); } finally { b.release(); }
          }
          return { status: "done", text: JSON.stringify(list) };
        },
      },
      {
        name: "deleguer_agent", description: "Confie une mission à un agent et attend sa réponse dans ce tour. Modèle ponctuel ; outils et accords Floppy. Pour un travail long avec notification, utilise lancer_travail_agent.",
        inputSchema: schema, level: "write", summary,
        handler: async (a, meta) => {
          if (!validate(a)) return failure("Consigne ou modèle invalide.", "Invalid instruction or model.");
          const b = await borrowAgent(ctx, String(a.agent));
          if (!b) return failure("Agent introuvable. Consulte lister_agents.", "Agent not found. Use lister_agents.");
          const lost = new AbortController();
          void b.lost.then(() => lost.abort());
          try {
            const signal = AbortSignal.any([lost.signal, AbortSignal.timeout(cfg.timeout_s * 1000), ...(meta.signal ? [meta.signal] : [])]);
            const text = await execute(b.service, a, signal, meta.origin);
            return { status: "done", text };
          } finally { b.release(); }
        },
      },
      {
        name: "lancer_travail_agent", description: "Lance en arrière-plan une mission avec les outils et accords Floppy. Rend son identifiant immédiatement ; une notification annonce la fin. Aucun terminal à surveiller.",
        inputSchema: schema, level: "write", summary,
        handler: async (a, meta) => {
          if (!validate(a)) return failure("Consigne ou modèle invalide.", "Invalid instruction or model.");
          if (running.size >= cfg.maxConcurrent) return failure("Trop de travaux sont déjà en cours.", "Too many tasks are already running.");
          const b = await borrowAgent(ctx, String(a.agent));
          if (!b) return failure("Agent introuvable. Consulte lister_agents.", "Agent not found. Use lister_agents.");
          if (!b.service.run) { b.release(); return failure("Cet agent propose seulement des sessions interactives.", "This agent only supports interactive sessions."); }
          if (running.size >= cfg.maxConcurrent) { b.release(); return failure("Trop de travaux sont déjà en cours.", "Too many tasks are already running."); }
          const id = randomUUID(); const controller = new AbortController();
          const job: Job = { id, agent: String(a.agent), model: a.modele ? String(a.modele) : undefined,
            instruction: instruction(a), state: "running", started: new Date().toISOString() };
          jobs.push(job);
          // Borne l'historique sans retirer les missions en cours.
          while (jobs.length > 100) { const i = jobs.findIndex((j) => j.state !== "running"); if (i < 0) break; jobs.splice(i, 1); }
          try { save(); } catch (e) { jobs.splice(jobs.indexOf(job), 1); b.release(); throw e; }
          void b.lost.then(() => controller.abort());
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(cfg.timeout_s * 1000)]);
          const done = Promise.resolve().then(async () => {
            try {
              job.result = (await execute(b.service, a, signal, meta.origin)).slice(0, 200000);
              const docs = ctx.maybe("documents");
              if (docs && job.result) {
                try { job.document = (await docs.save({ title: `${b.service.label} · ${job.instruction.slice(0, 80)}`,
                  markdown: job.result, source: "agent-jobs", tags: ["agent", b.service.id] })).id; }
                catch { ctx.log("warn", "document de la mission non enregistré ; résultat conservé dans le journal des travaux"); }
              }
              job.state = "done";
            } catch (e) {
              job.state = controller.signal.aborted ? "cancelled" : "failed";
              job.result = signal.aborted ? tr(T("Travail interrompu ou délai dépassé.", "Task interrupted or timed out."), ctx.assistant.language)
                : tr(errorText(e), ctx.assistant.language);
            } finally {
              job.finished = new Date().toISOString(); running.delete(id); b.release();
              try { save(); } catch { ctx.log("error", "journal des travaux non enregistré ; résultat disponible en mémoire"); }
              ctx.audit.write({ kind: "agent.job", id, agent: job.agent, model: job.model, state: job.state });
              if (ctx.alive) ctx.emit("initiative", { source: ctx.id, key: `agent-job:${id}`, importance: "normal",
                text: tr(job.state === "done" ? T(`Le travail de ${b.service.label} est terminé. Consulte le résultat ${id}.`, `${b.service.label}'s task is complete. Read result ${id}.`)
                  : T(`Le travail de ${b.service.label} s'est arrêté. Consulte le résultat ${id}.`, `${b.service.label}'s task stopped. Read result ${id}.`), ctx.assistant.language) });
            }
          });
          running.set(id, { controller, done });
          return { status: "done", text: T(`Travail lancé : ${id}. Je t'avertirai à la fin.`, `Task started: ${id}. I will notify you when it finishes.`) };
        },
      },
      {
        name: "travaux_agents", description: "Liste les travaux d'agent et leurs états ; avec id, rend la consigne et le résultat, y compris le document produit.",
        inputSchema: { type: "object", properties: { id: { type: "string" } } }, level: "read",
        handler: async (a) => {
          const job = a.id ? jobs.find((j) => j.id === a.id) : undefined;
          if (a.id && !job) return failure("Travail inconnu.", "Unknown task.");
          return { status: "done", text: JSON.stringify(job ?? jobs.map(({ instruction, result, ...j }) => j)) };
        },
      },
      {
        name: "arreter_travail_agent", description: "Arrête un travail d'agent en cours.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, level: "write",
        summary: (a) => T(`Arrêter le travail ${String(a.id)} ?`, `Stop task ${String(a.id)}?`),
        handler: async (a) => {
          const r = running.get(String(a.id)); if (!r) return failure("Ce travail n'est pas en cours.", "This task is not running.");
          r.controller.abort(); return { status: "done", text: T("Arrêt demandé.", "Stop requested.") };
        },
      },
    ]);
  },
});
