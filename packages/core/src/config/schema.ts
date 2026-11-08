// Schéma de la config (floppy.yml).
import { z } from "zod";

export const Rule = z.enum(["always", "ask", "never"]);
export type Rule = z.infer<typeof Rule>;

export const Level = z.enum(["read", "write", "send", "delete", "physical"]);
export type Level = z.infer<typeof Level>;

export const AssistantSettings = z.object({
  name: z.string().default("Floppy"),
  language: z.string().default("fr"),
  wake_words: z.array(z.string()).default(["floppy"]),
}).prefault({});
export type AssistantSettings = z.infer<typeof AssistantSettings>;

export const ApprovalSettings = z.object({
  read: Rule.default("always"),
  write: Rule.default("ask"),
  send: Rule.default("ask"),
  delete: Rule.default("ask"),
  physical: Rule.default("ask"),
  /** Autorisations ciblées de l'utilisateur : identité exacte de l'entrée, outil et niveau. */
  toolRules: z.array(z.object({
    source: z.string().min(1), tool: z.string().min(1), level: Level, rule: Rule,
  })).optional(),
  timeout_s: z.number().positive().default(90),
}).prefault({});
export type ApprovalSettings = z.infer<typeof ApprovalSettings>;

export const EntryConfig = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/i, "id : lettres, chiffres, - et _"),
  plugin: z.string(),
  config: z.unknown().optional(),
  disabled: z.boolean().default(false),
});
export type EntryConfig = z.infer<typeof EntryConfig>;

export const KernelConfig = z.object({
  assistant: AssistantSettings,
  plugins: z.array(EntryConfig).default([]),
  /** Choix du fournisseur quand plusieurs entrées fournissent le même service : { brain: "brain-cli" }. */
  services: z.record(z.string(), z.string()).default({}),
  /** Choix de départ des slots, tant que l'utilisateur n'a rien choisi : { "brain.main": "llm/gemma" } (entrée/élément). */
  slots: z.record(z.string(), z.string()).default({}),
  approvals: ApprovalSettings,
}).superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  for (const e of cfg.plugins) {
    if (seen.has(e.id)) ctx.addIssue({ code: "custom", message: `id en double : ${e.id}`, path: ["plugins"] });
    seen.add(e.id);
  }
});
export type KernelConfig = z.infer<typeof KernelConfig>;
export type KernelConfigInput = z.input<typeof KernelConfig>;
