// Registre des tâches : les tâches déclarées dans les manifestes (`tasks`), lancées par le noyau.
//
// Trois rôles séparés :
// - QUOI : la tâche, dans son plugin (service `task`). Elle ne connaît ni l'horloge ni les corps.
// - QUAND : la planification, gardée par un déclencheur (plugin Planificateur) ; la voix (`lancer_tache`) en est un autre.
// - ANNONCE : le noyau, après le passage (initiative + document montré).
// Règles : un seul passage à la fois par tâche ; délai max ; le plugin est réveillé s'il dort, et gardé en marche
// pendant le passage ; la fin du dernier passage réussi est gardée dans <home>/tasks.json.
import { readJsonFile, writeJsonAtomic } from "./util/files.ts";
import type { Audit } from "./audit.ts";
import type { TaskDef, TaskSchedule } from "./plugin/manifest.ts";
import type { TaskReason, TaskResult, TaskService } from "./services.ts";
import type { ToolDef } from "./tools.ts";
import { errorText, T, TextError, tr, type Text } from "./i18n.ts";

export interface TaskInfo {
  /** "<entrée>/<tâche>" (ex. "veille/quotidienne"). */
  key: string;
  entry: string;
  plugin: string;
  id: string;
  label: Text;
  description?: Text;
  /** Planification proposée par le plugin. */
  schedule?: TaskSchedule;
  /** Rubrique des réglages de la tâche (voir TaskDef.configure). */
  configure?: string;
  running: boolean;
  /** Fin du dernier passage réussi (ISO). */
  lastRun?: string;
  /** Dernier passage (réussi ou non). */
  last?: { at: string; ok: boolean; text: string };
}

export interface TaskOutcome {
  ok: boolean;
  /** Message pour l'utilisateur (le résumé de la tâche, ou l'échec en français et en anglais). */
  text: Text;
  result?: TaskResult;
}

/** Ce que le noyau donne au registre. */
export interface TaskHost {
  /** Tâches des entrées disponibles (pas désactivées, pas en erreur de manifeste). */
  declared(): { entry: string; plugin: string; def: TaskDef }[];
  /** Démarre l'entrée si besoin et la garde en marche jusqu'à release(). undefined : impossible. */
  acquire(entry: string): Promise<{ service: TaskService; release(): void } | undefined>;
  /** Annonce le résultat (initiative, document). */
  announce(info: TaskInfo, result: TaskResult, raison: TaskReason): void;
  audit: Audit;
  log(level: "info" | "warn" | "error", source: string, msg: string): void;
}

interface Saved { lastRun?: string; last?: { at: string; ok: boolean; text: string } }

export class TaskRegistry {
  private readonly running = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private saved: Record<string, Saved>;

  private readonly file: string;
  private readonly host: TaskHost;
  /** Après l'arrêt d'un passage (délai, « arrête »), temps laissé à la tâche pour finir d'elle-même. */
  abortGraceMs = 10_000;

  constructor(file: string, host: TaskHost) {
    this.file = file;
    this.host = host;
    this.saved = readJson(file);
  }

  list(): TaskInfo[] {
    return this.host.declared().map(({ entry, plugin, def }) => {
      const key = `${entry}/${def.id}`;
      const s = this.saved[key] ?? {};
      return {
        key, entry, plugin, id: def.id, label: def.label,
        ...(def.description ? { description: def.description } : {}),
        ...(def.schedule ? { schedule: def.schedule } : {}),
        ...(def.configure ? { configure: def.configure } : {}),
        running: this.running.has(key),
        ...(s.lastRun ? { lastRun: s.lastRun } : {}),
        ...(s.last ? { last: s.last } : {}),
      };
    });
  }

  /** Retrouve une tâche par sa clé, son id ou son nom (« veille du jour »). */
  find(q: string): TaskInfo | undefined {
    const all = this.list();
    const n = norm(q);
    return all.find((t) => t.key === q) ?? all.find((t) => t.id === q)
      ?? all.find((t) => norm(tr(t.label)) === n) ?? all.find((t) => n && (norm(tr(t.label)).includes(n) || norm(t.key).includes(n)));
  }

  /** Lance une tâche et attend sa fin. Jamais deux passages en même temps. */
  async run(key: string, raison: TaskReason): Promise<TaskOutcome> {
    const info = this.list().find((t) => t.key === key);
    if (!info) return { ok: false, text: T(`Tâche inconnue : ${key}.`, `Unknown task: ${key}.`) };
    if (this.running.has(key)) return { ok: false, text: alreadyRunning(info.label) };
    const def = this.host.declared().find((d) => `${d.entry}/${d.def.id}` === key)!.def;
    const ctrl = new AbortController();
    this.running.set(key, ctrl);
    this.changed();
    const timer = setTimeout(() => ctrl.abort(new TextError(T("délai dépassé", "timed out"))), (def.timeout_s ?? 600) * 1000);
    const started = new Date();
    let held: { service: TaskService; release(): void } | undefined;
    let out: TaskOutcome;
    try {
      held = await this.host.acquire(info.entry);
      if (!held) throw new TextError(T("le plugin ne démarre pas", "the plugin does not start"));
      const prev = this.saved[key]?.lastRun;
      // Une tâche qui ignore le signal d'arrêt ne reste pas « en cours » : on cesse de l'attendre peu après l'arrêt.
      const result = await untilAborted(held.service.run(def.id, { signal: ctrl.signal, raison, ...(prev ? { dernierPassage: new Date(prev) } : {}) }), ctrl.signal, this.abortGraceMs);
      if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new TextError(T("arrêtée", "stopped"));
      out = { ok: true, text: result.resume, result };
      this.saved[key] = { lastRun: started.toISOString(), last: { at: new Date().toISOString(), ok: true, text: result.resume } };
    } catch (e) {
      const why = tr(errorText(e), "fr");
      const whyEn = tr(errorText(e), "en");
      out = { ok: false, text: T(`« ${tr(info.label, "fr")} » a échoué : ${why}.`, `"${tr(info.label, "en")}" failed: ${whyEn}.`) };
      this.saved[key] = { ...this.saved[key], last: { at: new Date().toISOString(), ok: false, text: why } };
      this.host.log("warn", key, `tâche en échec : ${why}`);
    } finally {
      clearTimeout(timer);
      held?.release();
      this.running.delete(key);
    }
    writeJson(this.file, this.saved);
    this.host.audit.write({ kind: "task", source: info.entry, name: key, raison, ok: out.ok, text: tr(out.text, "fr").slice(0, 300) });
    this.host.log("info", key, `tâche finie (${raison}) : ${out.ok ? "ok" : "échec"}`);
    if (out.ok && out.result) this.host.announce(this.list().find((t) => t.key === key) ?? info, out.result, raison);
    this.changed();
    return out;
  }

  /** Arrête un passage en cours. */
  cancel(key: string): boolean {
    const c = this.running.get(key);
    if (!c) return false;
    c.abort(new TextError(T("arrêtée", "stopped")));
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** La liste a changé (plugin ajouté, arrêté, tâche lancée…). */
  changed(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* un abonné qui plante ne casse pas les autres */ }
    }
  }
}

/** Outils du noyau pour le cerveau : lister et lancer les tâches. */
export function taskTools(reg: TaskRegistry): ToolDef[] {
  const tasks = reg.list();
  const names = tasks.map((t) => `${t.key} (« ${tr(t.label)} »)`).join(", ") || "aucune";
  return [
    {
      name: "taches",
      description: "Liste les tâches que tu sais faire (veille, résumés…) : dernier passage, en cours ou non.",
      inputSchema: { type: "object", properties: {} },
      level: "read",
      handler: async () => {
        const l = reg.list();
        if (!l.length) return { status: "done", text: T("Aucune tâche.", "No tasks.") };
        return { status: "done", text: T(
          l.map((t) => `- ${t.key} : ${tr(t.label, "fr")}${t.running ? " (en cours)" : ""}${t.lastRun ? `, dernier passage ${t.lastRun}` : ", jamais lancée"}${t.last && !t.last.ok ? ` (dernier essai en échec : ${t.last.text})` : ""}`).join("\n"),
          l.map((t) => `- ${t.key}: ${tr(t.label, "en")}${t.running ? " (running)" : ""}${t.lastRun ? `, last run ${t.lastRun}` : ", never run"}${t.last && !t.last.ok ? ` (last attempt failed: ${t.last.text})` : ""}`).join("\n"),
        ) };
      },
    },
    {
      name: "lancer_tache",
      description: `Lance une tâche maintenant, en arrière-plan (« fais ma veille maintenant »). Le résultat arrive tout seul plus tard : dis juste que c'est lancé. Tâches : ${names}.`,
      inputSchema: { type: "object", properties: { tache: { type: "string", description: "Clé ou nom de la tâche." } }, required: ["tache"] },
      level: "write",
      summary: (a) => T(`Lancer la tâche « ${String(a.tache ?? "")} »`, `Run the task "${String(a.tache ?? "")}"`),
      handler: async (a) => {
        const t = reg.find(String(a.tache ?? ""));
        if (!t) return { status: "failed", text: T(`Je ne connais pas cette tâche. Tâches : ${names}.`, `I don't know this task. Tasks: ${names}.`) };
        if (t.running) return { status: "done", text: alreadyRunning(t.label) };
        void reg.run(t.key, "voix");
        return { status: "done", text: T(`« ${tr(t.label, "fr")} » est lancée. Le résultat arrivera tout seul.`, `"${tr(t.label, "en")}" is running. The result will come by itself.`) };
      },
    },
  ];
}

function alreadyRunning(label: Text): Text {
  return T(`« ${tr(label, "fr")} » est déjà en cours.`, `"${tr(label, "en")}" is already running.`);
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function readJson(file: string): Record<string, Saved> {
  return readJsonFile<Record<string, Saved>>(file) ?? {};
}

function writeJson(file: string, v: unknown): void {
  try { writeJsonAtomic(file, v); } catch { /* disque plein : on garde en mémoire */ }
}

/** Attend `p`, mais au plus `graceMs` après l'arrêt de `signal` (la raison de l'arrêt devient l'erreur). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  p.catch(() => {}); // abandonnée après l'arrêt : son rejet tardif n'est plus suivi
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      timer = setTimeout(() => reject(signal.reason instanceof Error ? signal.reason : new TextError(T("arrêtée", "stopped"))), graceMs);
    };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); });
  });
}
