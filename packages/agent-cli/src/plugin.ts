// Déclarations communes des adaptateurs : formulaires, secrets et offres, sans registre propre au noyau.
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { agentPrompt, definePlugin, findExe, itemSecret, T, TextError, type Context, type FieldDef } from "@floppy/core";
import type { AgentRunInput, BrainService } from "@floppy/contracts";
import { offerAgent, validAgentModel, agentTools, type AgentDefinition } from "./offers.ts";
import { prepareAgentProfile, parseAgentEvent, floppyToolName, type AgentProtocol } from "./profiles.ts";
import { runAgentStream } from "./stream.ts";
import { runHermes } from "./hermes.ts";

const Model = z.string().refine((s) => !s || validAgentModel(s));
export const ExternalAgentConfig = z.object({
  exe: z.string().optional(), exeArgs: z.array(z.string()).default([]),
  model: Model.default(""), delegateModel: Model.default(""), provider: Model.default(""),
  apiKeyEnv: z.string().refine((s) => !s || /^[A-Z][A-Z0-9_]*_API_KEY$/.test(s)).default(""),
  timeout_s: z.number().int().min(1).max(3600).default(120), cloud: z.boolean().default(true),
});

/** Un protocole absent signifie que seule la session interactive a été qualifiée. */
export function createExternalAgent(def: AgentDefinition & { protocol?: AgentProtocol }) {
  return definePlugin({
    manifest: {
      id: `agent-${def.id}`, version: "0.1.0", licence: "MIT",
      description: `Agent ${def.label} : sessions${def.protocol ? ", cerveau et délégation" : " interactives"}.`,
      sections: [{ id: "cerveau", label: T("Cerveau", "Brain") }],
      provides: def.protocol ? ["agent", "llm", "delegate"] : ["agent"],
      ...(def.protocol ? { inject: ["mcp"] } : {}),
      permissions: { exec: [def.program, "node"], net: ["127.0.0.1", "localhost", "::1"], "fs.write": [`workspaces/agent-${def.id}`], cloud: true },
      addable: { section: "cerveau", label: def.label, single: true, program: def.program, cloud: true, aliases: def.aliases,
        description: def.protocol ? T(`${def.label} : cerveau, délégation et sessions. Profil séparé, clé API dans le coffre.`,
          `${def.label}: brain, delegation and sessions. Separate profile, API key in the vault.`)
          : T(`${def.label} : ouvre une session interactive avec ses propres outils.`, `${def.label}: open an interactive session with its own tools.`),
        fields: [{ key: "exe", label: T("Programme", "Program"), type: "path", advanced: true }],
      },
    },
    config: ExternalAgentConfig,
    apply(ctx, cfg) {
      const store = ctx.items.store();
      const secret = itemSecret(ctx, (id) => `${ctx.plugin}/${ctx.id}/${id}/apiKey`);
      const config = () => ExternalAgentConfig.parse({ ...cfg, ...store.data.edits[def.id] });
      const exe = () => config().exe ?? findExe(def.program);
      const enabled = () => store.isEnabled(def.id);
      const fields: FieldDef[] = [
        { key: "exe", label: T("Programme", "Program"), type: "path", advanced: true },
        ...(def.protocol ? [
          { key: "model", label: T("Modèle du cerveau principal", "Main brain model"), type: "text", required: true },
          { key: "delegateModel", label: T("Modèle de délégation", "Delegation model"), type: "text",
            hint: T("Vide : même modèle que le cerveau principal.", "Empty: same model as the main brain.") },
          { key: "provider", label: T("Fournisseur", "Provider"), type: "text", advanced: true },
          { key: "apiKey", label: T("Clé API du profil Floppy", "Floppy profile API key"), type: "secret" },
          { key: "apiKeyEnv", label: T("Variable de la clé API", "API key variable"), type: "text", advanced: true,
            hint: T("Vide : déduite du fournisseur. Exemples : OPENAI_API_KEY, ANTHROPIC_API_KEY.", "Empty: inferred from the provider. Examples: OPENAI_API_KEY, ANTHROPIC_API_KEY.") },
          { key: "timeout_s", label: T("Délai maximal (secondes)", "Timeout (seconds)"), type: "number", min: 1, max: 3600, advanced: true },
          { key: "cloud", label: T("Modèle distant", "Remote model"), type: "boolean", advanced: true },
        ] satisfies FieldDef[] : []),
      ];
      ctx.items.declare({
        id: `${ctx.id}-agent`, section: "cerveau", label: def.label,
        offers: def.protocol ? ["agent", "llm", "delegate"] : ["agent"],
        kinds: [{ id: "cli", label: def.label, fields }],
        list: () => {
          const c = config();
          const missing = !exe() ? T("Programme introuvable : installe-le ou indique son chemin.", "Program not found: install it or set its path.")
            : def.protocol && !c.model ? T("Choisis un modèle pour le cerveau et la délégation. Les sessions restent disponibles.", "Choose a model for brain and delegation. Sessions remain available.") : undefined;
          return [{ id: def.id, kind: "cli", label: def.label, aliases: def.aliases, enabled: enabled(), cloud: c.cloud,
            editable: true, removable: false, toggleable: true,
            status: !enabled() ? "off" : missing ? "warn" : "ok", statusText: missing,
            detail: def.protocol ? T("Cerveau · délégation · sessions", "Brain · delegation · sessions") : T("Sessions interactives", "Interactive sessions"),
            values: { ...c, apiKey: secret.shown(def.id) } }];
        },
        update: async (id, values) => {
          if (id !== def.id) return { ok: false, text: T("Agent inconnu.", "Unknown agent.") };
          const { apiKey, ...rest } = values;
          const parsed = ExternalAgentConfig.safeParse({ ...config(), ...rest });
          if (!parsed.success) return { ok: false, text: T("Réglages de l'agent invalides.", "Invalid agent settings.") };
          secret.apply(def.id, apiKey); store.update(def.id, parsed.data); ctx.items.changed();
          return { ok: true, text: T("Agent enregistré. Les prochaines demandes utiliseront ces réglages.", "Agent saved. New requests will use these settings.") };
        },
        setEnabled: async (id, on) => {
          if (id !== def.id) return { ok: false, text: T("Agent inconnu.", "Unknown agent.") };
          store.setEnabled(id, on); ctx.items.changed();
          return { ok: true, text: on ? T("Agent activé.", "Agent enabled.") : T("Agent désactivé.", "Agent disabled.") };
        },
      });
      const mcp = def.protocol ? ctx.get("mcp") : undefined;
      const runIn = (f: Context) => async function* (input: AgentRunInput) {
        const c = config(); const program = exe(); const model = input.model ?? (c.delegateModel || c.model);
        if (!program || !model || !validAgentModel(model)) throw new TextError(T("Programme ou modèle de l'agent manquant ou invalide.", "Agent program or model is missing or invalid."));
        const tools = agentTools(f).map((t) => t.name);
        const scope = mcp!.scoped({ tools });
        let runs: string | undefined, turn: string | undefined;
        try {
          runs = f.workspace("runs");
          turn = mkdtempSync(join(runs, "turn-"));
          const key = secret.get(def.id);
          const command = prepareAgentProfile({ protocol: def.protocol!, home: join(turn, "profile"), cwd: turn,
            system: agentPrompt(f.assistant.name, agentTools(f), f.assistant.language),
            prompt: input.context?.length ? `${JSON.stringify(input.context)}\n\n${input.text}` : input.text,
            model, provider: c.provider, apiKeyEnv: c.apiKeyEnv || providerKeyEnv(c.provider || model.split("/")[0]!), apiKey: key, mcp: scope, tools });
          if (def.protocol === "hermes") {
            yield* runHermes(f, program, command, { exeArgs: c.exeArgs, model, provider: c.provider, timeout_s: c.timeout_s,
              signal: input.signal, tool: (name) => floppyToolName("hermes", name, tools) });
          } else {
            command.args.unshift(...c.exeArgs);
            yield* runAgentStream(f, program, command, { signal: input.signal, timeout_s: c.timeout_s,
              parse: (ev) => parseAgentEvent(def.protocol!, ev), tool: (name) => floppyToolName(def.protocol!, name, tools),
              secrets: [scope.token, ...(key ? [key] : [])] });
          }
        } finally {
          scope.close();
          // Seul le dossier temporaire créé pour ce tour peut être retiré, jamais un dossier choisi par l'utilisateur.
          if (turn && runs && resolve(turn).startsWith(resolve(runs) + sep)) {
            try { rmSync(turn, { recursive: true, force: true }); } catch { f.log("warn", "profil temporaire de l'agent encore occupé"); }
          }
        }
      };
      offerAgent(ctx, def, { exe, enabled, cloud: () => config().cloud, ...(def.protocol ? { run: runIn } : {}) });
      if (def.protocol) {
        const items = () => enabled() && exe() && config().model ? [{ id: def.id, label: def.label, aliases: def.aliases, cloud: config().cloud }] : [];
        const brainIn = (f: Context, delegated: boolean): BrainService => {
          const run = runIn(f);
          const history = new Map<string, { role: "user" | "assistant"; text: string }[]>();
          return { name: def.id, label: def.label, aliases: def.aliases, enabled,
            reset(session) { history.delete(session); },
            async *run(input) {
              const c = config();
              const context = input.context ?? history.get(input.session) ?? [];
              let result = "";
              for await (const event of run({ ...input, context, model: delegated ? c.delegateModel || c.model : c.model })) {
                if (event.type === "done") result = event.text;
                yield event;
              }
              history.set(input.session, [...context, { role: "user" as const, text: input.text }, { role: "assistant" as const, text: result }].slice(-12));
            } };
        };
        ctx.offer("delegate", { items, start(f) { f.provide("delegate", brainIn(f, true)); } });
        ctx.offer("llm", { items, start(f) { f.provide("llm", {
          label: def.label, get model() { return config().model; }, get cloud() { return config().cloud; }, agent: brainIn(f, false),
        }); } });
      }
    },
  });
}

function providerKeyEnv(provider: string): string {
  return ({ anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", xai: "XAI_API_KEY", deepseek: "DEEPSEEK_API_KEY" } as Record<string, string>)[provider] ?? "OPENAI_API_KEY";
}
