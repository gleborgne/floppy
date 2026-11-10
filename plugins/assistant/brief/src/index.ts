// Plugin « Point du matin » : chaque matin, une rubrique par source (agenda, mails, rappels, agents, veille…),
// puis un modèle écrit le point : « par où commencer », et une partie courte par rubrique.
//
// Rôles :
// - Les sources : tout plugin qui offre le service `brief` (contrat dans @floppy/contracts, brief.ts), élément par
//   élément (ex. « Microsoft 365 · agenda »). Ce plugin les liste (ctx.offers) et emprunte chacune le temps de sa
//   rubrique. Un plugin installé plus tard ajoute sa source tout seul.
// - Les sources « outil » : un outil en lecture choisi par l'utilisateur (ex. un outil MCP qui liste les PR), avec ses
//   arguments. Rien d'autre qu'un outil de niveau `read` n'est appelé.
// - La tâche « morning » (contrat task) : le noyau la lance (Planificateur à l'heure, ou « fais mon point »), puis
//   l'annonce. Les rubriques sont récoltées en code, en parallèle, chacune avec un délai : rien n'est oublié.
// - Le slot brief.writer (service completion) écrit le point. Sans lui (ou s'il échoue), le point est assemblé en code.
import { z } from "zod";
import { definePlugin, errorText, fold, T, TextError, tr, type ItemInfo, type ItemKind, type OpResult, type Text, type ToolDef } from "@floppy/core";
import type { BriefSection, BriefSource, CompletionService } from "@floppy/contracts";
import { assembled, briefTitle, moved, orderSources, WRITER_SCHEMA, writerPrompt, writerSystem, type Collected, type Lang } from "./compose.ts";

export { assembled, orderSources, moved, writerSystem, writerPrompt } from "./compose.ts";

const Config = z.object({
  /** Délai d'une source, en secondes : au-delà, elle est notée « indisponible » et le point continue sans elle. */
  sourceTimeout_s: z.number().int().min(5).max(300).default(60),
  /** Ce qui compte pour l'utilisateur, donné au modèle qui écrit (modifiable dans la rubrique). */
  focus: z.string().default(""),
});
type Config = z.infer<typeof Config>;

export interface BriefOptions {
  now?: () => Date;
}

/** Une source du point : offerte par un plugin (`offer`) ou outil choisi par l'utilisateur (`tool`). */
interface Source {
  id: string;
  label: string;
  type: "offer" | "tool";
  tool?: string;
  args?: Record<string, unknown>;
}

const TOOL_KIND: ItemKind = {
  id: "tool",
  label: T("Outil en lecture", "Read-only tool"),
  description: T(
    "Un outil de Floppy qui lit seulement (ex. un outil d'un connecteur qui liste tes PR à relire). Floppy l'appelle chaque matin avec ces arguments et met le résultat dans le point.",
    "A Floppy tool that only reads (e.g. a connector tool that lists your PRs to review). Floppy calls it every morning with these arguments and puts the result in the brief.",
  ),
  fields: [
    { key: "label", label: T("Nom de la rubrique", "Section name"), type: "text", required: true, placeholder: T("PR à relire", "PRs to review") },
    { key: "tool", label: T("Nom de l'outil", "Tool name"), type: "text", required: true, placeholder: "repo_list_pull_requests",
      hint: T("Seul un outil en lecture est accepté. « Essayer » l'appelle une fois et montre ce qu'il rend.", "Only a read-only tool is accepted. “Try” calls it once and shows what it returns.") },
    { key: "args", label: T("Arguments (JSON)", "Arguments (JSON)"), type: "textarea", default: "{}", placeholder: "{ \"status\": \"active\" }", advanced: true },
  ],
};

/** Arguments d'un outil, tapés en JSON : un objet, ou un texte d'erreur. */
function parseArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; text: Text } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, args: raw as Record<string, unknown> };
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, args: {} };
  try {
    const v: unknown = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, args: v as Record<string, unknown> };
  } catch { /* plus bas */ }
  return { ok: false, text: T("Les arguments doivent être un objet JSON, par exemple { \"max\": 5 }.", "Arguments must be a JSON object, for example { \"max\": 5 }.") };
}

/** Attend `p`, mais pas plus que `signal` (une source qui ignore le signal ne bloque pas le point). */
function bounded<V>(p: Promise<V>, signal: AbortSignal): Promise<V> {
  if (signal.aborted) return Promise.reject(new TextError(T("trop long", "took too long")));
  return new Promise<V>((ok, ko) => {
    const stop = () => ko(new TextError(T("trop long", "took too long")));
    signal.addEventListener("abort", stop, { once: true });
    p.then((v) => { signal.removeEventListener("abort", stop); ok(v); }, (e: unknown) => { signal.removeEventListener("abort", stop); ko(e); });
  });
}

export function createBriefPlugin(opts: BriefOptions = {}) {
  return definePlugin<Config>({
    manifest: {
      id: "brief",
      version: "0.1.0",
      licence: "MIT",
      description: "Point du matin : une rubrique par source (agenda, mails, rappels, agents, veille…), écrit par un modèle.",
      provides: ["task"],
      // brief : les sources (offertes par les autres plugins) ; documents : où ranger le point.
      optional: ["brief", "documents"],
      sections: [{
        id: "brief", label: T("Point du matin", "Morning brief"),
        description: T("Ce que Floppy rassemble chaque matin, dans quel ordre, et qui écrit le point. À la voix : « plus besoin des mails dans mon point ».",
          "What Floppy gathers every morning, in which order, and who writes the brief. By voice: “no more emails in my brief”."),
      }],
      slots: [{
        id: "brief.writer", service: "completion", section: "brief",
        label: T("Qui écrit le point", "Who writes the brief"),
        description: T("Le modèle qui lit les rubriques et écrit « par où commencer ». Il tourne seulement pendant le point.",
          "The model that reads the sections and writes “where to start”. It only runs during the brief."),
        none: T("Personne (rubriques mises bout à bout)", "Nobody (sections put end to end)"),
      }],
      tasks: [{
        id: "morning", label: T("Point du matin", "Morning brief"),
        description: T("Rassemble l'agenda, les mails, les rappels, les agents et la veille, puis écrit par où commencer.",
          "Gathers the calendar, emails, reminders, agents and news, then writes where to start."),
        schedule: { at: "08:00", days: [1, 2, 3, 4, 5] }, timeout_s: 300,
        configure: "brief",
      }],
      addable: {
        section: "brief", label: T("Point du matin", "Morning brief"), single: true,
        description: T("Chaque matin, ce qui compte aujourd'hui, en un seul message.", "Every morning, what matters today, in one message."),
      },
    },
    config: Config,
    apply(ctx, cfg) {
      const now = opts.now ?? (() => new Date());
      /** Langue de l'assistant : ce que Floppy écrit (le point, l'annonce). */
      const lang = (): Lang => (ctx.assistant.language === "en" ? "en" : "fr");
      const say = (t: Text) => tr(t, lang());
      const store = ctx.items.store();

      // ---------------------------------------------------------------- ce qui compte pour l'utilisateur
      let focus = ctx.settings.saved<string>("brief_focus") ?? cfg.focus;
      ctx.settings.declare([{
        key: "brief_focus", section: "brief", type: "text", maxLength: 500, risk: "free",
        label: T("Ce qui compte pour toi", "What matters to you"),
        description: T("Dit au modèle qui écrit le point, pour trier : « les clients d'abord, la veille en dernier ».",
          "Told to the model that writes the brief, to sort: “customers first, news last”."),
        get: () => focus, set: (v) => { focus = String(v ?? ""); },
      }]);

      // ---------------------------------------------------------------- les sources
      const order = (): string[] => {
        const o = store.data.extra.order;
        return Array.isArray(o) ? o.map(String) : [];
      };
      const setOrder = (list: string[]) => { store.data.extra.order = list; store.save(); };
      const toolSources = (): Source[] => Object.entries(store.data.added)
        .filter(([, a]) => a.kind === "tool")
        .map(([id, a]) => {
          const v = a.values as Record<string, unknown>;
          const args = parseArgs(v.args);
          return { id, label: String(v.label ?? id), type: "tool" as const, tool: String(v.tool ?? ""), args: args.ok ? args.args : {} };
        });
      const all = (): Source[] => orderSources([
        ...ctx.offers("brief").map((o): Source => ({ id: o.value, label: tr(o.label, lang()), type: "offer" })),
        ...toolSources(),
      ], order());
      const active = () => all().filter((s) => store.isEnabled(s.id));
      const find = (q: string): Source | undefined => {
        const n = fold(q).trim();
        if (!n) return undefined;
        const list = all();
        return list.find((s) => s.id === q || fold(s.label) === n)
          ?? list.find((s) => fold(s.label).includes(n) || n.includes(fold(s.label)))
          ?? list.find((s) => fold(s.id).includes(n) || n.split(/\s+/).some((w) => w.length > 3 && fold(s.label).includes(w)));
      };

      /** Lit une source. Rend sa rubrique (undefined : rien à dire), ou lève une erreur claire. */
      const collect = async (s: Source, signal: AbortSignal, since: Date | undefined): Promise<BriefSection | undefined> => {
        if (s.type === "tool") {
          const tool = ctx.tools.list().find((x) => x.name === s.tool);
          if (!tool) throw new TextError(T(`l'outil ${s.tool} n'existe pas (connecteur éteint ?)`, `tool ${s.tool} does not exist (connector off?)`));
          if (tool.level !== "read") throw new TextError(T(`l'outil ${s.tool} ne fait pas que lire : refusé`, `tool ${s.tool} does more than read: refused`));
          const r = await bounded(ctx.tools.call(s.tool!, s.args ?? {}, { caller: "brief", signal }), signal);
          if (r.status === "failed" || r.status === "refused") throw new TextError(r.text);
          return { title: s.label, markdown: r.text };
        }
        const b = await ctx.borrowItem<BriefSource>("brief", s.id);
        if (!b) throw new TextError(T("source indisponible (désactivée ou arrêtée)", "source unavailable (disabled or stopped)"));
        try {
          const r = await bounded(b.service.collect({ lang: lang(), now: now(), ...(since ? { since } : {}), signal }), signal);
          return r ?? undefined;
        } finally { b.release(); }
      };
      const gather = async (list: Source[], signal: AbortSignal, since: Date | undefined): Promise<Collected[]> => {
        const out = await Promise.all(list.map(async (s): Promise<Collected | undefined> => {
          const one = AbortSignal.any([signal, AbortSignal.timeout(cfg.sourceTimeout_s * 1000)]);
          try {
            const section = await collect(s, one, since);
            return section ? { source: s.id, label: s.label, section } : undefined;
          } catch (e) {
            if (signal.aborted) throw e;
            ctx.log("warn", `source ${s.id} : ${tr(errorText(e), "fr")}`);
            return { source: s.id, label: s.label, error: tr(errorText(e), lang()) };
          }
        }));
        return out.filter((c): c is Collected => !!c);
      };

      /** Fait écrire le point par le modèle. Rend undefined s'il n'y en a pas ou s'il échoue (le point est alors assemblé). */
      const write = async (items: Collected[], date: Date, signal: AbortSignal): Promise<{ say: string; markdown: string } | undefined> => {
        let w;
        try { w = await ctx.borrow<CompletionService>("brief.writer"); } catch (e) { ctx.log("warn", `rédacteur indisponible : ${String(e)}`); return undefined; }
        if (!w) return undefined;
        try {
          const r = await w.service.complete({ system: writerSystem(lang(), focus), prompt: writerPrompt(items, date, lang()), schema: WRITER_SCHEMA as unknown as Record<string, unknown>, signal });
          const j = r.json as { say?: unknown; markdown?: unknown } | undefined;
          const md = typeof j?.markdown === "string" ? j.markdown.trim() : "";
          if (!md) throw new Error("réponse sans markdown");
          const title = `# ${briefTitle(date, lang())}`;
          return { say: typeof j?.say === "string" ? j.say.trim() : "", markdown: md.startsWith("# ") ? md : `${title}\n\n${md}` };
        } catch (e) {
          if (signal.aborted) throw e;
          ctx.log("warn", `le modèle n'a pas écrit le point : ${String(e)}`);
          return undefined;
        } finally { w.release(); }
      };

      // ---------------------------------------------------------------- la tâche
      ctx.provide("task", {
        async run(taskId, input) {
          if (taskId !== "morning") throw new TextError(T(`tâche inconnue : ${taskId}`, `unknown task: ${taskId}`));
          const list = active();
          if (!list.length) {
            return { summary: say(T("Le point du matin n'a aucune source : ajoute Microsoft 365, la veille ou un outil (Réglages, rubrique Point du matin).",
              "The morning brief has no source: add Microsoft 365, the news watch or a tool (Settings, Morning brief section).")), announce: "normal" };
          }
          const date = now();
          const items = await gather(list, input.signal, input.lastRun);
          const written = items.some((c) => c.section && !c.section.empty) ? await write(items, date, input.signal) : undefined;
          const markdown = written?.markdown ?? assembled(items, date, lang());
          const docs = ctx.maybe("documents");
          const ref = docs ? await docs.save({ title: briefTitle(date, lang()), markdown, source: "brief", tags: ["brief"] }) : undefined;
          const full = items.filter((c) => c.section && !c.section.empty).length;
          const broken = items.filter((c) => c.error).length;
          const fallback = full
            ? T(`Ton point du matin est prêt : ${full} rubrique${full > 1 ? "s" : ""}.`, `Your morning brief is ready: ${full} section${full > 1 ? "s" : ""}.`)
            : T("Rien à te signaler ce matin.", "Nothing to report this morning.");
          const warn = broken ? T(` ${broken} source${broken > 1 ? "s n'ont" : " n'a"} pas répondu.`, ` ${broken} source${broken > 1 ? "s" : ""} did not answer.`) : "";
          const summary = `${written?.say || say(fallback)}${say(warn)}`;
          return ref ? { summary, document: ref, announce: "normal" } : { summary: `${summary}\n\n${markdown}`, announce: "normal" };
        },
      });

      // ---------------------------------------------------------------- la rubrique (fenêtre des réglages)
      const info = (s: Source): ItemInfo => {
        const on = store.isEnabled(s.id);
        const tool = s.type === "tool" ? ctx.tools.list().find((x) => x.name === s.tool) : undefined;
        const bad = s.type === "tool" && (!tool || tool.level !== "read");
        return {
          id: s.id, label: s.label, enabled: on, toggleable: true,
          kind: s.type === "tool" ? "tool" : undefined,
          detail: s.type === "tool" ? T(`outil ${s.tool}`, `tool ${s.tool}`) : T("donnée par un plugin", "given by a plugin"),
          status: !on ? "off" : bad ? "warn" : "ok",
          statusText: !on ? T("pas dans le point", "not in the brief")
            : bad ? (tool ? T("cet outil ne fait pas que lire : il ne sera pas appelé", "this tool does more than read: it will not be called") : T("outil introuvable (connecteur éteint ?)", "tool not found (connector off?)"))
            : undefined,
          ...(s.type === "tool" ? { values: { label: s.label, tool: s.tool, args: JSON.stringify(s.args ?? {}) }, editable: true, removable: true } : { editable: false, removable: false }),
          actions: [
            { id: "first", label: T("Mettre en premier", "Move to the top") },
            { id: "last", label: T("Mettre à la fin", "Move to the end") },
            { id: "try", label: T("Essayer", "Try") },
          ],
        };
      };
      const checkTool = (values: Record<string, unknown>): { ok: true; v: { label: string; tool: string; args: string } } | { ok: false; text: Text } => {
        const label = String(values.label ?? "").trim();
        const tool = String(values.tool ?? "").trim();
        if (!label) return { ok: false, text: T("Il faut un nom.", "A name is required.") };
        if (!tool) return { ok: false, text: T("Il faut le nom de l'outil.", "The tool name is required.") };
        const parsed = parseArgs(values.args);
        if (!parsed.ok) return parsed;
        const args = parsed.args;
        const t = ctx.tools.list().find((x) => x.name === tool);
        if (t && t.level !== "read") return { ok: false, text: T(`L'outil ${tool} ne fait pas que lire : il ne peut pas servir au point.`, `Tool ${tool} does more than read: it cannot be used in the brief.`) };
        return { ok: true, v: { label, tool, args: JSON.stringify(args) } };
      };
      const tryOne = async (s: Source): Promise<OpResult> => {
        try {
          const section = await collect(s, AbortSignal.timeout(cfg.sourceTimeout_s * 1000), undefined);
          if (!section) return { ok: true, text: T("Rien à dire pour l'instant.", "Nothing to say for now.") };
          const body = `${section.title}${section.empty ? " (—)" : ""}\n${section.markdown.slice(0, 1500)}`;
          return { ok: true, text: body };
        } catch (e) {
          return { ok: false, text: errorText(e) };
        }
      };
      ctx.items.declare({
        id: "brief-sources", section: "brief", order: 10,
        label: T("Sources du point", "Brief sources"),
        description: T("Ce que Floppy lit chaque matin, dans cet ordre. Les plugins ajoutent les leurs ; tu peux ajouter un outil en lecture.",
          "What Floppy reads every morning, in this order. Plugins add theirs; you can add a read-only tool."),
        addLabel: T("Ajouter un outil", "Add a tool"),
        kinds: [TOOL_KIND],
        list: () => all().map(info),
        add: async (kind, values) => {
          if (kind !== "tool") return { ok: false, text: T(`Type inconnu : ${kind}.`, `Unknown type: ${kind}.`) };
          const c = checkTool(values);
          if (!c.ok) return { ok: false, text: c.text };
          const id = store.add("tool", c.v as unknown as Record<string, unknown>, c.v.label, []);
          ctx.items.changed();
          return { ok: true, id, text: T(`« ${c.v.label} » ajouté au point.`, `“${c.v.label}” added to the brief.`) };
        },
        update: async (id, values) => {
          const cur = toolSources().find((s) => s.id === id);
          if (!cur) return { ok: false, text: T("Seul un outil ajouté se modifie.", "Only an added tool can be changed.") };
          const c = checkTool({ label: cur.label, tool: cur.tool, args: cur.args, ...values });
          if (!c.ok) return { ok: false, text: c.text };
          store.update(id, c.v as unknown as Record<string, unknown>);
          ctx.items.changed();
          return { ok: true, id, text: T(`« ${c.v.label} » modifié.`, `“${c.v.label}” updated.`) };
        },
        remove: async (id) => {
          const cur = toolSources().find((s) => s.id === id);
          if (!cur) return { ok: false, text: T("Seul un outil ajouté se retire. Une source d'un plugin se désactive.", "Only an added tool can be removed. A plugin's source can be turned off.") };
          store.remove(id);
          setOrder(order().filter((x) => x !== id));
          ctx.items.changed();
          return { ok: true, text: T(`« ${cur.label} » retiré du point.`, `“${cur.label}” removed from the brief.`) };
        },
        setEnabled: async (id, on) => {
          const cur = all().find((s) => s.id === id);
          if (!cur) return { ok: false, text: T("Source inconnue.", "Unknown source.") };
          store.setEnabled(id, on);
          ctx.items.changed();
          return { ok: true, text: on ? T(`« ${cur.label} » remis dans le point.`, `“${cur.label}” back in the brief.`) : T(`« ${cur.label} » retiré du point (rien n'est supprimé).`, `“${cur.label}” left out of the brief (nothing deleted).`) };
        },
        test: async (kind, values) => {
          const c = checkTool(values);
          if (!c.ok) return { ok: false, text: c.text };
          return tryOne({ id: "test", label: c.v.label, type: "tool", tool: c.v.tool, args: JSON.parse(c.v.args) as Record<string, unknown> });
        },
        action: async (id, action) => {
          const cur = all().find((s) => s.id === id);
          if (!cur) return { ok: false, text: T("Source inconnue.", "Unknown source.") };
          if (action === "try") return tryOne(cur);
          if (action === "first" || action === "last") {
            setOrder(moved(all().map((s) => s.id), id, action));
            ctx.items.changed();
            return { ok: true, text: action === "first" ? T(`« ${cur.label} » en premier.`, `“${cur.label}” first.`) : T(`« ${cur.label} » à la fin.`, `“${cur.label}” last.`) };
          }
          return { ok: false, text: T(`Action inconnue : ${action}`, `Unknown action: ${action}`) };
        },
      });

      // ---------------------------------------------------------------- outils pour le cerveau
      const tools: ToolDef[] = [
        {
          name: "brief_sources",
          description: "Liste les sources du point du matin (agenda, mails, rappels, veille, outils…), dans l'ordre, et si elles sont dans le point.",
          inputSchema: { type: "object", properties: {} },
          level: "read",
          handler: async () => {
            const list = all();
            if (!list.length) return { status: "done", text: T("Le point du matin n'a aucune source.", "The morning brief has no source.") };
            const line = (s: Source, i: number, en: boolean) => `${i + 1}. ${s.label}${store.isEnabled(s.id) ? "" : en ? " (left out)" : " (retirée)"}`;
            return { status: "done", text: T(list.map((s, i) => line(s, i, false)).join("\n"), list.map((s, i) => line(s, i, true)).join("\n")) };
          },
        },
        {
          name: "brief_source",
          description: "Change une source du point du matin quand l'utilisateur le demande. « plus besoin des mails dans mon point » → source: mails, action: off. « remets la veille » → action: on. « mets l'agenda en premier » → action: first. « la veille à la fin » → action: last. Appelle-le tout de suite, sans demander de confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              source: { type: "string", description: "Mots qui désignent la source (« mails », « agenda », « veille », « PR »)." },
              action: { type: "string", enum: ["on", "off", "first", "last"] },
            },
            required: ["source", "action"],
          },
          // Préférence du point, sans effet hors de lui, annulable par la même phrase inverse : pas d'accord demandé.
          level: "read",
          handler: async (a) => {
            const q = String(a.source ?? "");
            const s = find(q);
            if (!s) return { status: "failed", text: T(`Je ne trouve pas « ${q} » dans les sources du point. Utilise brief_sources.`, `I can't find “${q}” in the brief sources. Use brief_sources.`) };
            const act = String(a.action ?? "");
            if (act === "on" || act === "off") store.setEnabled(s.id, act === "on");
            else if (act === "first" || act === "last") setOrder(moved(all().map((x) => x.id), s.id, act));
            else return { status: "failed", text: T("Action inconnue.", "Unknown action.") };
            ctx.items.changed();
            const fr = { on: `« ${s.label} » est de nouveau dans le point`, off: `« ${s.label} » n'est plus dans le point`, first: `« ${s.label} » passe en premier`, last: `« ${s.label} » passe à la fin` }[act];
            const en = { on: `“${s.label}” is back in the brief`, off: `“${s.label}” is no longer in the brief`, first: `“${s.label}” goes first`, last: `“${s.label}” goes last` }[act];
            return { status: "done", text: T(`${fr}. Ce sera pris en compte au prochain point.`, `${en}. It will count from the next brief.`) };
          },
        },
      ];
      ctx.tools.register(tools);
    },
  });
}

export default createBriefPlugin();
