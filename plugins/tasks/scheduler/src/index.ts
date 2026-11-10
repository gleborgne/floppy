// Plugin `scheduler` (Planificateur) : l'HORLOGE. Il ne connaît aucune tâche en particulier.
//
// - Il lit les tâches du noyau (ctx.tasks.list) et lance celles qui sont « dues » (ctx.tasks.run(clé, "clock")).
// - La planification de l'utilisateur gagne sur celle du manifeste. Elle est un réglage texte par tâche, changeable
//   à la voix : « Floppy, fais ma veille à 8 h » → "08:00" ; « …du lundi au vendredi » → "08:00 mon-fri" ;
//   « toutes les 3 heures » → "every 3h" ; "never". « 8h » tout seul est une HEURE (08:00), jamais une période.
//   Les mêmes phrases en anglais sont comprises (« at 8am », « 7:30 mon-fri », « every 3 hours », « never ») ;
//   la valeur gardée est écrite en anglais (« 07:30 mon-fri », « every 3h », « never »), montrée traduite dans les fiches.
// - Rubrique Tâches : une fiche par tâche (prochain et dernier passage, planification, « Lancer maintenant »).
// - On compare l'heure du mur (Date.now) à la dernière réussite : ça marche aussi après la mise en veille du PC.
//   Un passage manqué (PC éteint) est donc rattrapé une fois, après un délai au démarrage (le temps de charger les modèles).
// - Les tâches se lancent l'une après l'autre. Une tâche qui échoue n'est pas relancée avant 30 minutes.
// - Politesse (attendre la fin d'un tour de conversation) : pas de signal propre côté plugin aujourd'hui, donc pas faite.
import { z } from "zod";
import { definePlugin, errorText, fold, T, TextError, tr, type ItemInfo, type OpResult, type TaskInfo, type TaskResult, type TaskSchedule, type Text } from "@floppy/core";
import type { NotifyService } from "@floppy/contracts";

const t = T;

export const Config = z.object({
  /** Attente avant la première vérification (secondes) : laisse les modèles se charger. */
  startupDelay_s: z.number().min(0).max(3600).default(120),
});
type Config = z.infer<typeof Config>;

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const RETRY_APRES_ECHEC_MS = 30 * MINUTE;
const NOMS_JOURS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"] as const;
const NOMS_LONGS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** Jours tels qu'ils sont gardés dans le réglage. */
const DAY_IDS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAYS_LONG = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function norm(s: string): string {
  return fold(s).trim();
}

export type ParsedSchedule = { ok: true; schedule: TaskSchedule | null } | { ok: false; error: Text };

/** Durée d'une période « 30m » ou « 3h », en millisecondes. undefined si ce n'est pas lisible. */
export function periodMs(every: string): number | undefined {
  const m = /^\s*(\d+)\s*(m|h)\s*$/i.exec(every);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n * (m[2]!.toLowerCase() === "h" ? 60 : 1) * MINUTE : undefined;
}

/** « lun », « lundi », « lundis », « mon », « monday », « mondays » → 1 … 7. */
function dayIndex(word: string): number | undefined {
  const w = norm(word).replace(/s$/, "");
  if (w.length < 3) return undefined;
  const i = NOMS_LONGS.findIndex((n) => n.startsWith(w));
  if (i >= 0) return i + 1;
  const e = DAYS_LONG.findIndex((n) => n.startsWith(w));
  return e < 0 ? undefined : e + 1;
}

function parseDays(text: string): number[] | undefined {
  const raw = norm(text).replace(/^on\s+/, "").replace(/\s+/g, " ").trim();
  if (/^(every ?day|daily)$/.test(raw)) return [1, 2, 3, 4, 5, 6, 7];
  if (/^(week ?days?|work ?days?)$/.test(raw)) return [1, 2, 3, 4, 5];
  if (/^(week-?ends?|the week-?end)$/.test(raw)) return [6, 7];
  const s = raw.replace(/\b(au|a|to|through|thru|until|till)\b/g, "-").replace(/\b(du|de|le|from|every)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^(tous les jours|chaque jour|quotidien)$/.test(s)) return [1, 2, 3, 4, 5, 6, 7];
  if (/^(semaine|en semaine|jours? ouvres?)$/.test(s)) return [1, 2, 3, 4, 5];
  if (/^week-?end$/.test(s)) return [6, 7];
  const days = new Set<number>();
  for (const part of s.split(/\s*(?:,|;|\bet\b|\band\b)\s*/).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split(/\s*-\s*/).map((x) => dayIndex(x));
      if (!a || !b) return undefined;
      for (let d = a; ; d = d === 7 ? 1 : d + 1) { days.add(d); if (d === b) break; }
    } else {
      for (const w of part.split(" ")) { const d = dayIndex(w); if (!d) return undefined; days.add(d); }
    }
  }
  return days.size ? [...days].sort((x, y) => x - y) : undefined;
}

/**
 * Lit une planification écrite : "07:30", "7h30", "8 h", "07:30 lun-ven", "07:30 lundi, jeudi", "3h", "30m",
 * ou "jamais" / "off" (pas de lancement automatique). schedule null = désactivée.
 * En anglais aussi : "8am", "at 7:30 pm", "7:30 mon-fri", "9:00 weekends", "every 3 hours", "never".
 */
export function parseSchedule(input: string): ParsedSchedule {
  let s = norm(input);
  if (["jamais", "off", "non", "desactive", "desactivee", "aucune", "aucun", "arret", "never", "none", "no", "disabled", "stop"].includes(s)) return { ok: true, schedule: null };
  const bad = (): ParsedSchedule => ({ ok: false, error: t(
    `Je ne comprends pas « ${input.trim()} ». Exemples : 07:30, 07:30 lun-ven, toutes les 3h, toutes les 30 min, jamais.`,
    `I don't understand "${input.trim()}". Examples: 07:30, 7:30 mon-fri, every 3 hours, every 30 min, never.`,
  ) });

  // Une période se dit toujours « toutes les … » (ou « chaque … », « every … ») ; « 30m » / « 30 min » seuls aussi
  // (ce n'est pas une heure). « 8h », « à 8 h », « 08:00 » sont des HEURES : à la voix, « à 8 h » arrive souvent sans le « à ».
  s = s.replace(/^(a|at)\s+(?=\d)/, "").replace(/\b([ap])\.\s?m\.?/g, "$1m");
  const every = /^(?:toutes? les\s+|chaque\s+|every\s+)(\d+)\s*(m|min|mins|mn|minutes?|h|hrs?|heures?|hours?)$/.exec(s)
    ?? /^(\d+)\s*(m|min|mn|minutes?)$/.exec(s);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2]!.startsWith("h") ? "h" : "m";
    if (n <= 0) return bad();
    if (unit === "m" && n < 5) return { ok: false, error: t("Une période de 5 minutes au moins.", "A period of at least 5 minutes.") };
    return { ok: true, schedule: { every: `${n}${unit}` } };
  }

  // « 8h », « 7:30 », et en anglais « 8am », « 7:30 pm ».
  const at = /^(\d{1,2})\s*(?::|h)\s*(\d{2})?\s*(?:(am|pm)\b)?\s*(.*)$/.exec(s)
    ?? /^(\d{1,2})\s*()(am|pm)\b\s*(.*)$/.exec(s);
  if (!at) return bad();
  let h = Number(at[1]);
  const mi = at[2] ? Number(at[2]) : 0;
  if (at[3]) {
    if (h < 1 || h > 12) return bad();
    h = at[3] === "pm" ? (h % 12) + 12 : h % 12;
  }
  if (h > 23 || mi > 59) return bad();
  const rest = at[4]!.trim();
  const heure = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  if (!rest) return { ok: true, schedule: { at: heure } };
  const days = parseDays(rest);
  if (!days) return bad();
  return { ok: true, schedule: days.length === 7 ? { at: heure } : { at: heure, days } };
}

/** Écrit une planification comme elle est gardée dans le réglage : "07:30", "07:30 mon-fri", "every 3h", "never". */
export function formatSchedule(schedule: TaskSchedule | null | undefined): string {
  if (!schedule) return "never";
  if ("every" in schedule) return `every ${schedule.every.endsWith("m") ? `${schedule.every.slice(0, -1)} min` : schedule.every}`;
  const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
  if (!days.length || days.length === 7) return schedule.at;
  return `${schedule.at} ${dayRanges(days, DAY_IDS)}`;
}

/** Jours triés, en plages de trois jours ou plus (« mon-fri ») et en jours isolés (« mon,thu »). */
function dayRanges(days: number[], names: readonly string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${names[days[i]! - 1]}-${names[days[j]! - 1]}`);
    else for (let k = i; k <= j; k++) parts.push(names[days[k]! - 1]!);
    i = j + 1;
  }
  return parts.join(",");
}

/** La même planification, écrite en français pour l'affichage. */
function formatScheduleFr(schedule: TaskSchedule | null | undefined): string {
  if (!schedule) return "jamais";
  if ("every" in schedule) return `toutes les ${schedule.every.endsWith("m") ? `${schedule.every.slice(0, -1)} min` : schedule.every}`;
  const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
  if (!days.length || days.length === 7) return schedule.at;
  return `${schedule.at} ${dayRanges(days, NOMS_JOURS)}`;
}

/** Une planification à lire, en français (comme on la garde) et en anglais. */
export function scheduleText(schedule: TaskSchedule | null | undefined): Text {
  const fr = formatScheduleFr(schedule);
  if (!schedule) return t(fr, "never");
  if ("every" in schedule) return t(fr, `every ${schedule.every.endsWith("m") ? `${schedule.every.slice(0, -1)} min` : schedule.every}`);
  const days = [...new Set(schedule.days ?? [])].sort((a, b) => a - b);
  if (!days.length || days.length === 7) return t(fr, schedule.at);
  const parts: string[] = [];
  for (let i = 0; i < days.length;) {
    let j = i;
    while (j + 1 < days.length && days[j + 1] === days[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${DAYS_SHORT[days[i]! - 1]}-${DAYS_SHORT[days[j]! - 1]}`);
    else for (let k = i; k <= j; k++) parts.push(DAYS_SHORT[days[k]! - 1]!);
    i = j + 1;
  }
  return t(fr, `${schedule.at} ${parts.join(",")}`);
}

/** Jour de la semaine, 1 = lundi … 7 = dimanche (heure locale). */
function isoDay(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

function atOn(now: Date, daysBack: number, at: string): Date {
  const [h, m] = at.split(":").map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, h, m, 0, 0);
}

/** Dernière heure prévue ≤ now (heure locale, jours respectés). undefined : planification « every », ou aucun jour. */
export function lastOccurrence(schedule: TaskSchedule, now: Date): Date | undefined {
  if (!("at" in schedule)) return undefined;
  for (let back = 0; back <= 7; back++) {
    const c = atOn(now, back, schedule.at);
    if (c.getTime() > now.getTime()) continue;
    if (!schedule.days || schedule.days.includes(isoDay(c))) return c;
  }
  return undefined;
}

/** Prochaine heure prévue > now. undefined : planification « every », ou aucun jour. */
export function nextOccurrence(schedule: TaskSchedule, now: Date): Date | undefined {
  if (!("at" in schedule)) return undefined;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const c = atOn(now, -ahead, schedule.at);
    if (c.getTime() <= now.getTime()) continue;
    if (!schedule.days || schedule.days.includes(isoDay(c))) return c;
  }
  return undefined;
}

function ms(d: Date | string | undefined): number | undefined {
  if (d === undefined) return undefined;
  const n = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * La tâche doit-elle se lancer maintenant ?
 * - `at` : jamais passée, ou dernière réussite avant la dernière heure prévue (donc un passage manqué est rattrapé) ;
 * - `every` : jamais passée, ou la période est écoulée depuis la dernière réussite.
 */
export function isDue(schedule: TaskSchedule, lastRun: Date | string | undefined, now: Date): boolean {
  const last = ms(lastRun);
  if ("every" in schedule) {
    const p = periodMs(schedule.every);
    if (p === undefined) return false;
    return last === undefined || now.getTime() - last >= p;
  }
  const occ = lastOccurrence(schedule, now);
  if (!occ) return false;
  return last === undefined || last < occ.getTime();
}

// ---------------------------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------------------------

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function createSchedulerPlugin() {
  return definePlugin<Config>({
    manifest: {
      id: "scheduler",
      version: "0.1.0",
      licence: "MIT",
      description: "Les tâches : quand elles tournent (horloge) et où envoyer leur résultat (Telegram, mail…).",
      sections: [
        { id: "tasks", label: t("Tâches", "Tasks"), description: t("Quand Floppy lance ses tâches tout seul (veille du jour…), et où il envoie le résultat.", "When Floppy runs its tasks by itself, and where it sends the result.") },
      ],
      // notify : les canaux d'envoi (offerts par les plugins Telegram, mail…) ; documents : le contenu à envoyer.
      optional: ["notify", "documents"],
    },
    config: Config,
    apply(ctx, cfg) {
      /** Planification choisie par l'utilisateur, par clé de tâche (texte normalisé). Absente : celle du manifeste. */
      const choices = new Map<string, string>();
      const declared = new Set<string>();
      const lastAttempt = new Map<string, number>();
      /** Moment où l'utilisateur a changé l'heure : ce qui précède ne se rattrape pas (« à 9 h » dit à 8 h n'a rien à rattraper). */
      const changedAt = new Map<string, number>();
      const startedAt = Date.now();
      let checking = false;
      /** Langue de l'assistant : messages envoyés (Telegram, mail) et annonces. */
      const lang = () => ctx.assistant.language;

      const choice = (key: string): TaskSchedule | null | undefined => {
        const own = choices.get(key);
        if (own === undefined) return undefined;
        const p = parseSchedule(own);
        return p.ok ? p.schedule : undefined;
      };
      /** Planification en vigueur : null = désactivée, undefined = aucune. */
      const effective = (info: TaskInfo): TaskSchedule | null | undefined => choice(info.key) ?? (choices.has(info.key) ? null : info.schedule);

      // ---- Où envoyer le résultat : canaux « notify » (Telegram, mail…), choisis par tâche. Envoyer = sortir de chez
      // l'utilisateur : choisir un canal à la voix demande l'accord (risque « ask »). Les noms sont résolus à l'envoi.
      /** Choix de l'utilisateur par tâche, tel qu'il l'a écrit (« Mon canal, Gmail perso »). */
      const destinations = new Map<string, string>();
      const channels = () => ctx.offers("notify");
      const NULLE_PART = /^(nulle part|rien|aucun|aucune|personne|non|jamais|off|nowhere|nothing|none|nobody|no|never|)$/;
      /** Canaux désignés par un texte : par nom, par entrée (« telegram »), ou par valeur exacte. */
      const resolve = (text: string): { found: { value: string; label: string }[]; unknown: string[] } => {
        const found: { value: string; label: string }[] = [];
        const unknown: string[] = [];
        const all = channels();
        for (const raw of text.split(/\s*(?:,|;|\+|\bet\b|\band\b)\s*/)) {
          const part = norm(raw).replace(/^(sur|par|a|au|dans|on|by|via|to|in)\s+/, "").replace(/^(mon|ma|le|la|my|the)\s+/, "").trim();
          if (NULLE_PART.test(part)) continue;
          const lab = (o: { label: Text }) => norm(tr(o.label));
          const hit = all.find((o) => o.value === raw.trim()) ?? all.find((o) => lab(o) === part)
            ?? all.find((o) => lab(o).includes(part) || part.includes(lab(o))) ?? all.find((o) => norm(o.entry).includes(part) || part.includes(norm(o.entry)));
          if (hit) { if (!found.some((f) => f.value === hit.value)) found.push({ value: hit.value, label: tr(hit.label) }); }
          else unknown.push(raw.trim());
        }
        return { found, unknown };
      };
      const channelList = (): Text => {
        const names = channels().map((o) => tr(o.label));
        return names.length
          ? t(names.map((n) => `« ${n} »`).join(", "), names.map((n) => `"${n}"`).join(", "))
          : t("aucun (ajoute-en un dans Réglages, rubrique Notifications)", "none (add one in Settings, Notifications section)");
      };

      /** Envoie un message sur un canal (emprunté le temps de l'envoi). Lève une erreur claire. */
      const sendTo = async (value: string, msg: { title: string; markdown: string }): Promise<void> => {
        const b = await ctx.borrowItem<NotifyService>("notify", value);
        if (!b) throw new TextError(t("canal indisponible (désactivé ou supprimé)", "channel unavailable (disabled or removed)"));
        try { await b.service.send(msg); } finally { b.release(); }
      };
      /** Le contenu d'un résultat : le document s'il y en a un, sinon le résumé. */
      const messageOf = async (label: Text, result: TaskResult): Promise<{ title: string; markdown: string }> => {
        const doc = result.document ? await ctx.maybe("documents")?.get(result.document.id) : undefined;
        return doc ? { title: doc.title, markdown: doc.markdown } : { title: tr(label, lang()), markdown: result.summary };
      };
      ctx.on("task.done", ({ key, label, result }) => {
        const text = destinations.get(key);
        if (!text) return;
        const { found } = resolve(text);
        if (!found.length) return;
        void (async () => {
          const msg = await messageOf(label, result);
          for (const c of found) {
            try {
              await sendTo(c.value, msg);
              ctx.log("info", `« ${tr(label)} » envoyée sur ${c.label}`);
              ctx.audit.write({ kind: "notify", task: key, channel: c.value, ok: true });
            } catch (e) {
              const why = errorText(e);
              ctx.audit.write({ kind: "notify", task: key, channel: c.value, ok: false, error: tr(why, "fr") });
              const text = tr(t(
                `L'envoi de « ${tr(label, "fr")} » sur ${c.label} a échoué : ${tr(why, "fr")}.`,
                `Sending "${tr(label, "en")}" to ${c.label} failed: ${tr(why, "en")}.`,
              ), lang());
              ctx.emit("initiative", { source: "scheduler", text, importance: "normal" });
            }
          }
        })().catch((e) => ctx.log("error", `envoi : ${String(e)}`));
      });

      // Outil : « envoie la synthèse sur Telegram », « envoie-moi ça par mail ». Niveau « send » : accord à chaque fois.
      ctx.tools.register([{
        name: "send_document",
        description: "Envoie un document (par défaut le dernier : la veille du jour, une réponse affichée…) sur un canal de l'utilisateur : Telegram, mail… « envoie la synthèse sur Telegram » → channel: telegram. « envoie-moi la veille par mail » → channel: mail, what: veille.",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Nom du canal (« Telegram », « Gmail perso »…)." },
            what: { type: "string", description: "Quel document : « last » (défaut, le dernier), « veille », ou des mots du titre." },
          },
          required: ["channel"],
        },
        level: "send",
        summary: (a) => t(
          `Envoyer ${a.what ? `« ${String(a.what)} »` : "le dernier document"} sur ${String(a.channel ?? "")}`,
          `Send ${a.what ? `"${String(a.what)}"` : "the latest document"} to ${String(a.channel ?? "")}`,
        ),
        handler: async (a) => {
          const { found } = resolve(String(a.channel ?? ""));
          if (!found.length) return { status: "failed", text: t(`Je ne connais pas ce canal. Canaux : ${tr(channelList(), "fr")}.`, `I don't know this channel. Channels: ${tr(channelList(), "en")}.`) };
          const docs = ctx.maybe("documents");
          if (!docs) return { status: "failed", text: t("Pas de documents à envoyer (plugin Documents absent).", "No documents to send (Documents plugin missing).") };
          const q = norm(String(a.what ?? "last"));
          const list = await docs.list({ max: 50 });
          const ref = !q || q === "dernier" || q === "derniere" || q === "last" || q === "latest" ? list[0]
            : list.find((d) => d.tags.some((t2) => norm(t2) === q)) ?? list.find((d) => q.split(" ").every((w) => norm(d.title).includes(w)));
          if (!ref) return { status: "failed", text: t("Je ne trouve pas ce document.", "I can't find this document.") };
          const doc = await docs.get(ref.id);
          if (!doc) return { status: "failed", text: t("Je ne trouve pas ce document.", "I can't find this document.") };
          const done: string[] = [];
          for (const c of found) {
            try { await sendTo(c.value, { title: doc.title, markdown: doc.markdown }); done.push(c.label); }
            catch (e) {
              const why = errorText(e);
              return { status: "failed", text: t(`L'envoi sur ${c.label} a échoué : ${tr(why, "fr")}.`, `Sending to ${c.label} failed: ${tr(why, "en")}.`) };
            }
          }
          return { status: "done", text: t(`« ${doc.title} » envoyé sur ${done.join(" et ")}.`, `"${doc.title}" sent to ${done.join(" and ")}.`) };
        },
      }]);

      const updateStatus = () => {
        const now = new Date();
        let best: { when: Date; label: Text } | undefined;
        for (const info of ctx.tasks.list()) {
          const s = effective(info);
          if (!s) continue;
          let when: Date | undefined;
          if ("every" in s) {
            const p = periodMs(s.every);
            const l = ms(info.lastRun);
            if (p !== undefined) when = new Date(l === undefined ? now.getTime() : Math.max(l + p, now.getTime()));
          } else when = nextOccurrence(s, now);
          if (when && (!best || when < best.when)) best = { when, label: info.label };
        }
        if (!best) { ctx.items.status(t("aucune tâche planifiée", "no task scheduled")); return; }
        const today = best.when.toDateString() === now.toDateString();
        const day = today ? "" : `${NOMS_JOURS[isoDay(best.when) - 1]} `;
        const dayEn = today ? "" : `${DAYS_SHORT[isoDay(best.when) - 1]} `;
        ctx.items.status(t(`prochaine : ${tr(best.label, "fr")} à ${day}${hhmm(best.when)}`, `next: ${tr(best.label, "en")} at ${dayEn}${hhmm(best.when)}`), "ok");
      };

      /** Un tour d'horloge : lance, l'une après l'autre, les tâches dues. Ne lève jamais. */
      const check = async (): Promise<void> => {
        if (!ctx.alive || checking) return;
        if (Date.now() - startedAt < cfg.startupDelay_s * 1000) return;
        checking = true;
        try {
          for (const info of ctx.tasks.list()) {
            if (!ctx.alive) break;
            const s = effective(info);
            if (!s || info.running) continue;
            const now = new Date();
            const floor = changedAt.get(info.key);
            const lastRun = floor === undefined ? info.lastRun : new Date(Math.max(floor, ms(info.lastRun) ?? 0));
            if (!isDue(s, lastRun, now)) continue;
            const tried = lastAttempt.get(info.key);
            if (tried !== undefined && now.getTime() - tried < RETRY_APRES_ECHEC_MS) continue;
            lastAttempt.set(info.key, now.getTime());
            try {
              const out = await ctx.tasks.run(info.key, "clock");
              if (out.ok) lastAttempt.delete(info.key);
              else ctx.log("warn", `tâche ${info.key} : échec`, { text: out.text });
            } catch (e) {
              ctx.log("error", `tâche ${info.key} : ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } catch (e) {
          ctx.log("error", `horloge : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          checking = false;
          try { updateStatus(); } catch { /* rien */ }
        }
      };

      // ---- Rubrique Tâches : une fiche par tâche. Sa planification (réglage) est montrée DANS la fiche.
      const keyOf = (info: TaskInfo) => `tasks.${info.key.replace("/", ".")}`;
      const sendKey = (info: TaskInfo) => `${keyOf(info)}.send`;
      const itemId = (info: TaskInfo) => info.key.replace("/", ".");
      const byItem = (id: string) => ctx.tasks.list().find((x) => itemId(x) === id);
      const when = (d: Date, now: Date, l: "fr" | "en" = "fr"): string => {
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const en = l === "en";
        const day = d.toDateString() === now.toDateString() ? (en ? "today" : "aujourd'hui")
          : d.toDateString() === tomorrow.toDateString() ? (en ? "tomorrow" : "demain")
          : d.toDateString() === yesterday.toDateString() ? (en ? "yesterday" : "hier")
          : en ? `${DAYS_SHORT[isoDay(d) - 1]} ${d.getDate()}/${d.getMonth() + 1}` : `${NOMS_LONGS[isoDay(d) - 1]} ${d.getDate()}/${d.getMonth() + 1}`;
        return en ? `${day} at ${hhmm(d)}` : `${day} à ${hhmm(d)}`;
      };
      const nextRun = (info: TaskInfo, s: TaskSchedule, now: Date): Date | undefined => {
        if (!("every" in s)) return nextOccurrence(s, now);
        const p = periodMs(s.every);
        const l = ms(info.lastRun);
        return p === undefined ? undefined : new Date(l === undefined ? now.getTime() : Math.max(l + p, now.getTime()));
      };
      const taskInfo = (info: TaskInfo): ItemInfo => {
        const now = new Date();
        const s = effective(info);
        const next = s ? nextRun(info, s, now) : undefined;
        const last = info.last;
        const to = destinations.get(info.key);
        const parts = (l: "fr" | "en") => (l === "en" ? [
          info.running ? "running…" : s ? (next ? `next: ${when(next, now, l)}` : "") : "no automatic run",
          last ? `last: ${when(new Date(last.at), now, l)}${last.ok ? "" : " (failed)"}` : "never run",
          to ? `sent to ${to}` : "",
        ] : [
          info.running ? "en cours…" : s ? (next ? `prochain : ${when(next, now)}` : "") : "pas de lancement automatique",
          last ? `dernier : ${when(new Date(last.at), now)}${last.ok ? "" : " (échec)"}` : "jamais lancée",
          to ? `envoyée à ${to}` : "",
        ]).filter(Boolean).join(" · ");
        const detail = (l: "fr" | "en") => [
          tr(info.description, l),
          last && !last.ok ? (l === "en" ? `Last attempt failed: ${last.text}` : `Dernier essai en échec : ${last.text}`)
            : last?.ok ? (l === "en" ? `Last result: ${last.text}` : `Dernier résultat : ${last.text}`) : "",
        ].filter(Boolean).join("\n");
        return {
          id: itemId(info), label: info.label, enabled: !!s,
          detail: t(detail("fr"), detail("en")),
          status: info.running ? "loading" : !s ? "off" : last && !last.ok ? "warn" : "ok",
          statusText: t(parts("fr"), parts("en")),
          toggleable: true, editable: false, removable: false,
          actions: info.running ? [] : [{ id: "run", label: t("Lancer maintenant", "Run now") }],
          settings: [keyOf(info), sendKey(info)],
          ...(info.configure ? { section: info.configure } : {}),
        };
      };
      ctx.items.declare({
        id: "tasks", section: "tasks", order: 10,
        label: t("Tâches des plugins", "Plugin tasks"),
        description: t("Chaque plugin apporte ses tâches. Choisis quand elles tournent, ou lance-les tout de suite.", "Each plugin brings its tasks. Choose when they run, or run them right now."),
        list: () => ctx.tasks.list().map(taskInfo),
        setEnabled: async (id, on): Promise<OpResult> => {
          const info = byItem(id);
          if (!info) return { ok: false, text: t(`Tâche inconnue : ${id}`, `Unknown task: ${id}`) };
          const r = await ctx.settings.change(keyOf(info), on ? formatSchedule(info.schedule ?? { at: "07:30" }) : "never");
          const fr = tr(info.label, "fr"), en = tr(info.label, "en");
          return { ok: r.ok, text: r.ok ? (on ? t(`« ${fr} » se lancera toute seule.`, `"${en}" will run by itself.`) : t(`« ${fr} » ne se lancera plus toute seule (tu peux toujours la lancer).`, `"${en}" will no longer run by itself (you can still run it).`)) : r.text };
        },
        action: async (id, action): Promise<OpResult> => {
          const info = byItem(id);
          if (!info || action !== "run") return { ok: false, text: t("Action inconnue.", "Unknown action.") };
          const fr = tr(info.label, "fr"), en = tr(info.label, "en");
          if (info.running) return { ok: false, text: t(`« ${fr} » est déjà en cours.`, `"${en}" is already running.`) };
          void ctx.tasks.run(info.key, "manual").finally(() => ctx.items.changed());
          setTimeout(() => ctx.items.changed(), 50);
          return { ok: true, text: t(`« ${fr} » est lancée. Le résultat arrivera tout seul.`, `"${en}" is running. The result will come by itself.`) };
        },
      });

      /** Un réglage « planification » par tâche (les nouvelles tâches sont ajoutées quand la liste change). */
      const declareNew = () => {
        for (const info of ctx.tasks.list()) {
          if (declared.has(info.key)) continue;
          declared.add(info.key);
          const key = keyOf(info);
          const saved = ctx.settings.saved<string>(key);
          if (typeof saved === "string" && parseSchedule(saved).ok) choices.set(info.key, formatSchedule((parseSchedule(saved) as { schedule: TaskSchedule | null }).schedule));
          const name = tr(info.label, "fr"), nameEn = tr(info.label, "en");
          ctx.settings.declare([{
            key,
            label: t(`Quand lancer « ${name} »`, `When to run "${nameEn}"`),
            description: t(
              "Une heure (07:30), avec des jours (07:30 lun-ven, 09:00 week-end), une période (toutes les 3h, toutes les 30 min), ou jamais.",
              "A time (07:30, 8am), with days (07:30 mon-fri, 09:00 weekends), a period (every 3 hours, every 30 min), or never. Saved as “07:30 mon-fri”, “every 3h” or “never”.",
            ),
            type: "text",
            section: "tasks",
            maxLength: 60,
            presets: [
              { value: "07:00", label: t("07:00", "07:00") },
              { value: "07:30", label: t("07:30", "07:30") },
              { value: "08:00", label: t("08:00", "08:00") },
              { value: "07:30 mon-fri", label: t("07:30 en semaine", "07:30 weekdays") },
              { value: "every 3h", label: t("toutes les 3 h", "every 3 h") },
              { value: "never", label: t("jamais", "never") },
            ],
            risk: "free",
            get: () => choices.get(info.key) ?? formatSchedule(ctx.tasks.list().find((x) => x.key === info.key)?.schedule),
            set: (value) => {
              const p = parseSchedule(String(value));
              if (!p.ok) throw new TextError(p.error);
              choices.set(info.key, formatSchedule(p.schedule));
              changedAt.set(info.key, Date.now());
              updateStatus();
              ctx.items.changed();
            },
          }, {
            key: sendKey(info),
            label: t(`Envoyer « ${name} » à`, `Send "${nameEn}" to`),
            description: t(
              "Après chaque passage réussi, le résultat part aussi sur ces canaux (Telegram, mail… : rubrique Notifications). Plusieurs : séparés par une virgule. « nulle part » : rien n'est envoyé.",
              "After each successful run, the result is also sent to these channels (Telegram, mail…: Notifications section). Several: comma-separated. “nowhere”: nothing is sent.",
            ),
            type: "text",
            section: "tasks",
            maxLength: 200,
            // Les canaux du moment (ils changent quand on en ajoute un) : relus à chaque affichage.
            get presets() {
              const opts = channels().map((o) => ({ value: tr(o.label), label: o.label }));
              return [...opts, ...(opts.length > 1 ? [{ value: opts.map((o) => o.value).join(", "), label: t("tous", "all") }] : []), { value: "nowhere", label: t("nulle part", "nowhere") }];
            },
            // Envoyer hors de chez l'utilisateur : à la voix, l'accord est demandé ; arrêter d'envoyer est libre.
            risk: "ask",
            riskFor: (v) => (resolve(String(v)).found.length ? "ask" : "free"),
            get: () => destinations.get(info.key) || "nowhere",
            set: (value) => {
              const text = String(value).trim();
              const { found, unknown } = resolve(text);
              // Au démarrage, les canaux ne sont peut-être pas encore là : on garde le texte, résolu à l'envoi.
              if (unknown.length && channels().length) {
                throw new TextError(t(
                  `Je ne connais pas ${unknown.map((u) => `« ${u} »`).join(", ")}. Canaux : ${tr(channelList(), "fr")}.`,
                  `I don't know ${unknown.map((u) => `"${u}"`).join(", ")}. Channels: ${tr(channelList(), "en")}.`,
                ));
              }
              if (!found.length && !unknown.length) destinations.delete(info.key);
              else destinations.set(info.key, found.length && !unknown.length ? found.map((f) => f.label).join(", ") : text);
              ctx.items.changed();
            },
          }]);
          const savedTo = ctx.settings.saved<string>(sendKey(info));
          if (typeof savedTo === "string" && savedTo.trim() && !NULLE_PART.test(norm(savedTo))) destinations.set(info.key, savedTo.trim());
        }
      };

      declareNew();
      ctx.tasks.onChange(() => { try { declareNew(); updateStatus(); ctx.items.changed(); } catch (e) { ctx.log("warn", `tâches : ${String(e)}`); } });
      updateStatus();
      ctx.timeout(() => { void check(); }, cfg.startupDelay_s * 1000);
      ctx.interval(() => { void check(); }, MINUTE);
    },
  });
}

export default createSchedulerPlugin();
