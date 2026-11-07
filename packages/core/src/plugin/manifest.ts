// Le manifeste d'un plugin et la fonction definePlugin.
import { z, type ZodType } from "zod";
import type { Context } from "./context.ts";
import type { FieldDef } from "../catalog.ts";
import type { Text } from "../i18n.ts";
import type { SectionDef } from "../sections.ts";

/** Ce que le plugin veut toucher. Accordé une fois par l'utilisateur (voir docs/spec/securite.md). */
export interface Permissions {
  "fs.read"?: string[];
  "fs.write"?: string[];
  net?: string[];
  exec?: string[];
  cloud?: boolean;
  /** "respond" : peut répondre aux demandes d'accord (corps, voix). Réservé aux plugins qui parlent à l'utilisateur. */
  approvals?: "respond";
}

/**
 * Choix d'un élément (« slot ») : déclaré par le plugin qui en a besoin (le consommateur).
 * Les éléments viennent des plugins qui offrent `service` (ctx.offer). Le noyau en fait un réglage `slot.<id>`
 * (fenêtre, voix, CLI) et démarre à la demande l'élément choisi (un « fork » de son plugin).
 */
export interface SlotDef {
  /** Unique (ex. "brain.main", "voice.tts"). Sert aussi de rôle pour la fenêtre. */
  id: string;
  /** Service offert par les éléments (ex. "llm", "tts", "live"). */
  service: string;
  /** Rubrique de la fenêtre des réglages. */
  section: string;
  label: Text;
  description?: Text;
  /** Présent : le choix est facultatif, et ce texte nomme « aucun » (ex. « Séparé », « Pas de délégation »). */
  none?: Text;
  /** Avec `none` : sans choix de l'utilisateur, prendre quand même le premier élément (« aucun » reste un choix). */
  defaultFirst?: boolean;
  /**
   * Indice pour la fenêtre. "mode" : onglets de mode en haut de la rubrique (« aucun » = le mode par défaut, ex. Local / Live).
   * "tabs" : un onglet par plugin qui offre le service (ex. Voix, mot d'activation). Sans : une liste groupée par plugin.
   */
  display?: "mode" | "tabs";
}

/** Quand une tâche tourne : « at » (HH:MM, heure locale, jours 1 = lundi … 7 = dimanche) ou « every » (« 30m », « 3h »). */
export type TaskSchedule = { at: string; jours?: number[] } | { every: string };

/**
 * Une tâche que le plugin sait faire (ex. « Veille du jour »). Lue sans démarrer le plugin : le noyau la liste,
 * la lance (à l'heure, à la voix), réveille le plugin s'il dort, puis annonce le résultat. Le plugin fournit `task`.
 */
export interface TaskDef {
  /** Unique dans le plugin (minuscules, chiffres, tirets). */
  id: string;
  label: Text;
  description?: Text;
  /** Planification proposée par défaut (l'utilisateur la change dans la rubrique Tâches ou à la voix). */
  schedule?: TaskSchedule;
  /** Durée max d'un passage, en secondes (défaut : 600). */
  timeout_s?: number;
  /**
   * Rubrique de la fenêtre des réglages qui règle cette tâche (ex. "veille") : montrée sous la tâche (« Réglages »),
   * plus dans le menu. Un plugin qui ne sert qu'à une tâche n'encombre pas le menu.
   */
  configure?: string;
}

export interface Manifest {
  id: string;
  version: string;
  /** Description montrée dans la fenêtre des réglages (texte simple ou { fr, en }). */
  description?: Text;
  licence: string;
  /** Services fournis (ctx.provide). */
  provides?: string[];
  /** Sélecteur de fournisseur géré par l'hôte (aucun accès au noyau depuis un plugin). */
  serviceSelection?: { service: string; section: string; label: Text; none: Text; role?: string };
  /** Choix d'éléments dont ce plugin a besoin (voir SlotDef, ctx.slot). */
  slots?: SlotDef[];
  /** Tâches que ce plugin sait faire (voir TaskDef). Demande `task` dans provides. */
  tasks?: TaskDef[];
  /**
   * Démarré seulement quand un plugin actif en a besoin (inject, ctx.use). Arrêté quand plus personne ne s'en sert.
   * Pour les plugins qui coûtent (mémoire du GPU, processus, connexions).
   */
  lazy?: boolean;
  /** Services obligatoires : sans eux, le plugin attend (état « waiting »). */
  inject?: string[];
  /** Services facultatifs : le plugin démarre sans eux, et redémarre quand ils arrivent ou changent. */
  optional?: string[];
  /** `in-process` : plugins du noyau. Les « mains » (MCP, CLI) tournent toujours hors processus. */
  runtime?: "in-process" | "out-of-process";
  permissions?: Permissions;
  /**
   * Rubriques de la fenêtre des réglages que ce plugin apporte (voir sections.ts). Les doublons entre plugins
   * fusionnent : le premier libellé gagne. Une rubrique sans réglage ni élément n'est pas montrée.
   */
  sections?: SectionDef[];
  /**
   * L'utilisateur peut ajouter ou retirer ce plugin depuis la fenêtre des réglages (voir apps.ts).
   * `fields` : formulaire de la config de l'entrée. `single` : une seule entrée possible.
   */
  /**
   * `program` : programme dont le plugin a besoin (ex. « codex »). Trouvé sur la machine, le premier lancement propose
   * le plugin (et l'ajoute s'il n'est pas dans la config).
   */
  addable?: { section: string; label: Text; description?: Text; fields?: FieldDef[]; cloud?: boolean; single?: boolean; aliases?: string[]; program?: string };
}

const strs = z.array(z.string().min(1));
const text = z.union([z.string().min(1), z.object({ fr: z.string().min(1), en: z.string().optional() }).catchall(z.string().optional())]);
const PermissionsSchema = z.object({
  "fs.read": strs.optional(),
  "fs.write": strs.optional(),
  net: strs.optional(),
  // Noms de programmes sans extension ("python", "claude"…), ou "*" (commandes choisies par l'utilisateur).
  exec: strs.optional(),
  cloud: z.boolean().optional(),
  approvals: z.literal("respond").optional(),
}).strict();

/** Forme attendue d'un manifeste (le reste — sections, addable — est vérifié par ses propres registres). */
const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "minuscules, chiffres et tirets, commence par une lettre"),
  version: z.string().min(1),
  licence: z.string().min(1),
  description: text.optional(),
  provides: strs.optional(),
  serviceSelection: z.object({ service: z.string().min(1), section: z.string().min(1), label: text, none: text, role: z.string().optional() }).optional(),
  slots: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9.-]*$/, "minuscules, chiffres, points et tirets"),
    service: z.string().min(1), section: z.string().min(1), label: text, description: text.optional(), none: text.optional(),
    defaultFirst: z.boolean().optional(),
    display: z.enum(["mode", "tabs"]).optional(),
  }).strict()).optional(),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "minuscules, chiffres et tirets"),
    label: text, description: text.optional(),
    schedule: z.union([
      z.object({ at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure HH:MM"), jours: z.array(z.number().int().min(1).max(7)).optional() }).strict(),
      z.object({ every: z.string().regex(/^\d+(m|h)$/, "durée « 30m » ou « 3h »") }).strict(),
    ]).optional(),
    timeout_s: z.number().int().positive().optional(),
    configure: z.string().min(1).optional(),
  }).strict()).optional(),
  lazy: z.boolean().optional(),
  inject: strs.optional(),
  optional: strs.optional(),
  runtime: z.enum(["in-process", "out-of-process"]).optional(),
  permissions: PermissionsSchema.optional(),
}).passthrough().superRefine((m, ctx) => {
  if (m.serviceSelection && !m.provides?.includes(m.serviceSelection.service)) {
    ctx.addIssue({ code: "custom", path: ["serviceSelection"], message: "le service choisi doit figurer dans provides" });
  }
  if (m.tasks?.length && !m.provides?.includes("task")) {
    ctx.addIssue({ code: "custom", path: ["tasks"], message: "un plugin qui déclare des tâches doit avoir « task » dans provides" });
  }
  const ids = (m.tasks ?? []).map((t) => t.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["tasks"], message: "deux tâches ont le même id" });
});

/** Texte d'erreur si le manifeste est invalide, sinon undefined. */
export function manifestError(m: unknown): string | undefined {
  const r = ManifestSchema.safeParse(m);
  if (r.success) return undefined;
  return r.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ");
}

/** Nom d'un programme sans dossier ni extension : « C:\x\Llama-Server.exe » → « llama-server ». */
export function programName(command: string): string {
  const base = command.replace(/^.*[\\/]/, "");
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

/** Le manifeste autorise-t-il ce programme ? */
export function execAllowed(permissions: Permissions | undefined, command: string): boolean {
  const list = permissions?.exec ?? [];
  return list.includes("*") || list.some((x) => x.toLowerCase() === programName(command));
}

export interface PluginDef<C = unknown> {
  manifest: Manifest;
  /** Schéma de la config de l'entrée (validé avant apply). */
  config?: ZodType<C>;
  apply(ctx: Context, config: C): void | Promise<void>;
}

export function definePlugin<C = Record<string, never>>(def: PluginDef<C>): PluginDef<C> {
  return def;
}
