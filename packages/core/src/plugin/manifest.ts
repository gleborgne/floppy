// Le manifeste d'un plugin et la fonction definePlugin.
import { z, type ZodType } from "zod";
import type { Context } from "./context.ts";
import type { FieldDef } from "../catalog.ts";
import type { Text } from "../i18n.ts";
import type { ServiceName } from "../services.ts";
import type { SectionDef } from "../sections.ts";
import type { Logo } from "../logo.ts";

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
  service: ServiceName;
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
  /**
   * Place dans la chaîne de la rubrique (1, 2, 3…). Les slots d'une rubrique qui ont tous un `step` forment une chaîne :
   * la fenêtre les montre dans cet ordre, reliés par des flèches (ex. Écoute : parole → texte → mot d'activation).
   */
  step?: number;
}

/** Quand une tâche tourne : « at » (HH:MM, heure locale, days 1 = lundi … 7 = dimanche) ou « every » (« 30m », « 3h »). */
export type TaskSchedule = { at: string; days?: number[] } | { every: string };

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
  provides?: ServiceName[];
  /** Choix d'éléments dont ce plugin a besoin (voir SlotDef, ctx.slot). */
  slots?: SlotDef[];
  /** Tâches que ce plugin sait faire (voir TaskDef). Demande `task` dans provides. */
  tasks?: TaskDef[];
  /**
   * Démarré seulement quand un plugin actif en a besoin (inject, ctx.use). Arrêté quand plus personne ne s'en sert.
   * Pour les plugins qui coûtent (mémoire du GPU, processus, connexions).
   */
  lazy?: boolean;
  /**
   * Délai pour `apply` (défaut : 60 s). Au-delà, l'entrée passe en erreur et ce qu'elle a ouvert est fermé.
   * Le temps passé à attendre d'autres plugins (ctx.use, ctx.slot) ne compte pas.
   */
  startTimeout_s?: number;
  /** Services obligatoires : sans eux, le plugin attend (état « waiting »). */
  inject?: ServiceName[];
  /** Services facultatifs : le plugin démarre sans eux, et redémarre quand ils arrivent ou changent. */
  optional?: ServiceName[];
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
   * `logo` : logo de l'outil, montré sur sa ligne (ctx.items.logo le remplace pendant que le plugin tourne).
   */
  addable?: { section: string; label: Text; description?: Text; fields?: FieldDef[]; cloud?: boolean; single?: boolean; aliases?: string[]; program?: string; logo?: Logo };
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

const SlotSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/, "minuscules, chiffres, points et tirets"),
  service: z.string().min(1), section: z.string().min(1), label: text, description: text.optional(), none: text.optional(),
  defaultFirst: z.boolean().optional(),
  display: z.enum(["mode", "tabs"]).optional(),
  step: z.number().int().min(1).max(20).optional(),
}).strict();

const TaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "minuscules, chiffres et tirets"),
  label: text, description: text.optional(),
  schedule: z.union([
    z.object({ at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure HH:MM"), days: z.array(z.number().int().min(1).max(7)).optional() }).strict(),
    z.object({ every: z.string().regex(/^\d+(m|h)$/, "durée « 30m » ou « 3h »") }).strict(),
  ]).optional(),
  timeout_s: z.number().int().positive().optional(),
  configure: z.string().min(1).optional(),
}).strict();

// Rubriques de la fenêtre des réglages (SectionDef). La forme seulement : la fusion des doublons est faite par SectionRegistry.
const SectionSchema = z.object({
  id: z.string().min(1), label: text, description: text.optional(),
  order: z.number().optional(), icon: z.string().optional(), parent: z.string().optional(), merge: z.boolean().optional(), view: z.string().optional(),
}).strict();

// Champs d'un formulaire (FieldDef) : forme complète ; les contrôles de fond (clés uniques, types connus de la fenêtre)
// restent dans le catalogue (catalog.ts) et la fenêtre des réglages.
const FieldSchema = z.object({
  key: z.string().min(1),
  label: text,
  type: z.enum(["text", "number", "boolean", "select", "secret", "path", "list", "textarea", "keyvalue", "audio"]),
  options: z.array(z.object({ value: z.string(), label: text }).strict()).optional(),
  placeholder: text.optional(), hint: text.optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  advanced: z.boolean().optional(),
  showIf: z.object({ key: z.string(), values: z.array(z.unknown()) }).strict().optional(),
  filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) }).strict()).optional(),
  directory: z.boolean().optional(),
  min: z.number().optional(), max: z.number().optional(),
  prompts: z.array(text).optional(),
  textKey: z.string().optional(),
  seconds: z.object({ min: z.number(), max: z.number() }).strict().optional(),
}).strict();

const LogoSchema = z.union([z.string(), z.object({ program: z.string() }).strict(), z.object({ handler: z.string() }).strict()]);

const AddableSchema = z.object({
  section: z.string().min(1), label: text, description: text.optional(),
  fields: z.array(FieldSchema).optional(),
  cloud: z.boolean().optional(), single: z.boolean().optional(),
  aliases: z.array(z.string()).optional(), program: z.string().optional(), logo: LogoSchema.optional(),
}).strict();

/**
 * Forme attendue d'un manifeste : tous les champs de `Manifest`, et AUCUN autre (un champ inconnu ou mal écrit est refusé
 * à tous les niveaux). Les contrôles de fond (ex. clés de formulaire, rubriques) restent dans leurs registres.
 */
const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "minuscules, chiffres et tirets, commence par une lettre"),
  version: z.string().min(1),
  licence: z.string().min(1),
  description: text.optional(),
  provides: strs.optional(),
  slots: z.array(SlotSchema).optional(),
  tasks: z.array(TaskSchema).optional(),
  lazy: z.boolean().optional(),
  startTimeout_s: z.number().positive().max(3600).optional(),
  inject: strs.optional(),
  optional: strs.optional(),
  permissions: PermissionsSchema.optional(),
  sections: z.array(SectionSchema).optional(),
  addable: AddableSchema.optional(),
}).strict().superRefine((m, ctx) => {
  if (m.tasks?.length && !m.provides?.includes("task")) {
    ctx.addIssue({ code: "custom", path: ["tasks"], message: "un plugin qui déclare des tâches doit avoir « task » dans provides" });
  }
  const ids = (m.tasks ?? []).map((t) => t.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["tasks"], message: "deux tâches ont le même id" });
});

// --- Le type `Manifest` et le schéma ne doivent pas dériver : ces types échouent à `npm run typecheck` si l'un a un champ
// (ou un niveau de champ : slots, tâches, permissions, rubriques, formulaire…) que l'autre n'a pas.
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Same<Schema extends z.ZodType, Iface> = Eq<keyof z.input<Schema>, keyof Iface> extends true ? Eq<z.input<Schema>, Iface> : false;
type Ok<T extends true> = T;
// Le schéma laisse libres les noms de services (un plugin peut avoir le sien) : le type les nomme, on compare en les élargissant.
type Loose<T> = T extends ServiceName ? string : T extends readonly (infer E)[] ? Loose<E>[] : T extends object ? { [K in keyof T]: Loose<T[K]> } : T;
export type ManifestSchemaMatchesInterface = [
  Ok<Same<typeof ManifestSchema, Loose<Manifest>>>,
  Ok<Same<typeof PermissionsSchema, Permissions>>,
  Ok<Same<typeof SlotSchema, Loose<SlotDef>>>,
  Ok<Same<typeof TaskSchema, TaskDef>>,
  Ok<Same<typeof SectionSchema, SectionDef>>,
  Ok<Same<typeof FieldSchema, FieldDef>>,
  Ok<Same<typeof AddableSchema, NonNullable<Manifest["addable"]>>>,
];

/** Les champs que le schéma connaît à la racine d'un manifeste (un plugin tiers n'en a pas d'autres : voir `manifestMismatch`). */
export const manifestFields: readonly string[] = Object.keys(ManifestSchema.shape);

/** Un problème de manifeste, dans les deux langues. */
export interface ManifestProblem { fr: string; en: string }

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Champs connus de l'objet à `path` (descend dans les tableaux, les optionnels et les unions). */
function knownKeys(schema: unknown, path: readonly PropertyKey[]): string[] {
  let cur: unknown[] = [schema];
  const expand = (list: unknown[]): unknown[] => list.flatMap((s) => {
    const def = (s as { _zod?: { def?: { type?: string; innerType?: unknown; options?: unknown[] } } })._zod?.def;
    if (def?.type === "optional" || def?.type === "nullable") return expand([def.innerType]);
    if (def?.type === "union") return expand(def.options ?? []);
    return [s];
  });
  for (const seg of path) {
    cur = expand(cur).flatMap((s) => {
      const def = (s as { _zod?: { def?: { type?: string; element?: unknown; shape?: Record<string, unknown> } } })._zod?.def;
      if (def?.type === "array") return [def.element];
      if (def?.type === "object" && def.shape && typeof seg === "string" && seg in def.shape) return [def.shape[seg]];
      return [];
    });
  }
  return expand(cur).flatMap((s) => Object.keys((s as { _zod?: { def?: { shape?: Record<string, unknown> } } })._zod?.def?.shape ?? {}));
}

/** Le champ connu le plus proche d'un champ inconnu (faute de frappe, pluriel, casse), ou undefined. */
function closest(key: string, known: string[]): string | undefined {
  const k = key.toLowerCase();
  let best: string | undefined;
  let bestD = Math.max(2, Math.floor(key.length / 4)) + 1;
  for (const c of known) {
    const d = c.toLowerCase() === k ? 0 : distance(k, c.toLowerCase());
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function problems(issues: readonly z.core.$ZodIssue[], path: readonly PropertyKey[] = []): { path: string; fr: string; en: string }[] {
  return issues.flatMap((i) => {
    const at = [...path, ...i.path];
    if (i.code === "unrecognized_keys") {
      const known = knownKeys(ManifestSchema, at);
      return i.keys.map((key) => {
        const near = closest(key, known);
        return {
          path: [...at, key].join("."),
          fr: near ? `champ inconnu (voulais-tu « ${near} » ?)` : "champ inconnu",
          en: near ? `unknown field (did you mean "${near}"?)` : "unknown field",
        };
      });
    }
    // Union (ex. `schedule`, `logo`) : on montre la branche qui a le moins de problèmes (la plus proche de ce qui était écrit).
    if (i.code === "invalid_union" && i.errors.length) {
      const branches = i.errors.map((e) => problems(e, at));
      return branches.reduce((a, b) => (b.length < a.length ? b : a));
    }
    return [{ path: at.join(".") || "(racine)", fr: i.message, en: i.message }];
  });
}

/** Problèmes du manifeste dans les deux langues (le texte des règles de fond est celui du schéma), ou undefined si valide. */
export function manifestProblem(m: unknown): ManifestProblem | undefined {
  const r = ManifestSchema.safeParse(m);
  if (r.success) return undefined;
  const list = problems(r.error.issues);
  return { fr: list.map((p) => `${p.path} : ${p.fr}`).join(" ; "), en: list.map((p) => `${p.path} : ${p.en}`).join(" ; ") };
}

/** Texte d'erreur (en français) si le manifeste est invalide, sinon undefined. */
export function manifestError(m: unknown): string | undefined {
  return manifestProblem(m)?.fr;
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
