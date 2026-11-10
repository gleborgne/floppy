// Rappels et minuteurs à la voix, locaux : « rappelle-moi dans 10 minutes d'appeler Paul », « minuteur 5 minutes ».
// - Stockés dans <home>/scheduler/reminders.json (écriture atomique) : ils survivent à un redémarrage.
// - Un seul minuteur (ctx.timeout) est armé sur le prochain rappel, par paliers de 20 jours au plus (limite de setTimeout).
//   ctx.timeout ne s'annule pas : un minuteur dépassé (rappel annulé) se réveille, ne trouve rien et réarme.
// - À l'heure : une annonce « important » par l'événement `initiative`, puis le rappel est retiré (au plus une annonce).
// - Un rappel dont l'heure est passée pendant l'arrêt est annoncé peu après le démarrage, avec la mention « en retard ».
// - Niveau `write` : l'accord suit la règle des réglages ; l'utilisateur peut la lever par une règle ciblée (toolRules).
import { join } from "node:path";
import { fold, readJsonFile, T, tr, writeJsonAtomic, type Context, type Text } from "@floppy/core";
import type { BriefRequest, BriefSection } from "@floppy/contracts";

export interface Reminder {
  id: string;
  text: string;
  /** Heure prévue (ms depuis l'époque). */
  due: number;
  created: number;
}

export interface RemindersOptions {
  /** Horloge (ms). Par défaut Date.now. */
  now?: () => number;
  /** Attente après le démarrage avant d'annoncer les rappels en retard (secondes). */
  startupDelay_s?: number;
}

const MINUTE = 60_000;
const MAX_AHEAD_MS = 365 * 24 * 60 * MINUTE;
/** setTimeout plafonne à ~24,8 jours : on arme par paliers. */
const MAX_STEP_MS = 20 * 24 * 60 * MINUTE;
const MAX_REMINDERS = 50;
/** Au-delà de ce retard, l'annonce le dit. */
const LATE_MS = 2 * MINUTE;

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** « AAAA-MM-JJTHH:MM » (heure locale) → ms, ou undefined si illisible ou impossible (31 février). */
export function parseLocalDateTime(s: string): number | undefined {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})\s*$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return undefined;
  return date.getTime();
}

/** L'heure prévue en clair, dans les deux langues (« demain à 14:30 », « tomorrow at 14:30 »). */
export function whenText(due: number, now: number): Text {
  const d = new Date(due), n = new Date(now);
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(d) - day0(n)) / 86_400_000);
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() === n.getFullYear() ? "" : `/${d.getFullYear()}`}`;
  const fr = diff === 0 ? "aujourd'hui" : diff === 1 ? "demain" : `le ${date}`;
  const en = diff === 0 ? "today" : diff === 1 ? "tomorrow" : `on ${date}`;
  return T(`${fr} à ${hhmm(d)}`, `${en} at ${hhmm(d)}`);
}

/** Rubrique du point du matin : les rappels prévus d'ici minuit (et ceux en retard). */
export function remindersSection(list: Reminder[], req: BriefRequest): BriefSection {
  const en = req.lang === "en";
  const now = +req.now;
  const end = new Date(req.now); end.setHours(24, 0, 0, 0);
  const today = list.filter((r) => r.due < +end).sort((a, b) => a.due - b.due);
  const title = en ? "Reminders today" : "Rappels du jour";
  if (!today.length) return { title, markdown: en ? "No reminder today." : "Aucun rappel aujourd'hui.", empty: true };
  const lines = today.map((r) => `- ${hhmm(new Date(r.due))}${en ? ": " : " : "}${r.text}${r.due < now ? (en ? " (late)" : " (en retard)") : ""}`);
  return { title, markdown: lines.join("\n"), urgent: today.some((r) => r.due - now < 60 * MINUTE) };
}

const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

export function registerReminders(ctx: Context, opts: RemindersOptions = {}): { list: () => Reminder[] } {
  const clock = opts.now ?? Date.now;
  const file = join(ctx.home, "scheduler", "reminders.json");
  const startedAt = clock();
  const notBefore = startedAt + (opts.startupDelay_s ?? 10) * 1000;
  const lang = () => ctx.assistant.language;

  let reminders: Reminder[] = [];
  const stored = readJsonFile<{ reminders?: unknown }>(file);
  if (Array.isArray(stored?.reminders)) {
    reminders = (stored.reminders as Partial<Reminder>[]).filter((r): r is Reminder =>
      typeof r?.id === "string" && typeof r.text === "string" && typeof r.due === "number" && Number.isFinite(r.due))
      .map((r) => ({ id: r.id, text: r.text, due: r.due, created: typeof r.created === "number" ? r.created : r.due }));
  }
  const save = () => writeJsonAtomic(file, { reminders });
  const sorted = () => [...reminders].sort((a, b) => a.due - b.due);

  let seq = reminders.reduce((n, r) => Math.max(n, Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);

  // ---- Minuteur unique.
  let armed: { target: number; token: number } | undefined;
  let tokens = 0;
  const arm = (): void => {
    if (!ctx.alive || !reminders.length) return;
    const first = Math.max(sorted()[0]!.due, notBefore);
    const now = clock();
    const target = Math.min(first, now + MAX_STEP_MS);
    if (armed && armed.target <= target) return; // le minuteur en cours se réveillera assez tôt
    const token = ++tokens;
    armed = { target, token };
    ctx.timeout(() => fire(token), Math.max(0, target - now));
  };
  const fire = (token: number): void => {
    if (armed?.token !== token) return;
    armed = undefined;
    if (!ctx.alive) return;
    const now = clock();
    if (now < notBefore) { arm(); return; }
    const due = sorted().filter((r) => r.due <= now);
    if (due.length) {
      reminders = reminders.filter((r) => r.due > now);
      try { save(); } catch (e) { ctx.log("error", `rappels : écriture impossible : ${String(e)}`); }
      for (const r of due) announce(r, now);
    }
    arm();
  };
  const announce = (r: Reminder, now: number): void => {
    const late = now - r.due > LATE_MS;
    const at = hhmm(new Date(r.due));
    const text = tr(late
      ? T(`Rappel en retard, prévu à ${at} : ${r.text}`, `Late reminder, due at ${at}: ${r.text}`)
      : T(`Rappel : ${r.text}`, `Reminder: ${r.text}`), lang());
    ctx.audit.write({ kind: "reminder", stage: "due", id: r.id, late });
    ctx.emit("initiative", { source: "scheduler", text, importance: "important", key: `reminder:${r.id}` });
  };

  // ---- Outils.
  const line = (r: Reminder, now: number): Text => {
    const w = whenText(r.due, now);
    return T(`${r.id} : ${r.text} (${tr(w, "fr")})`, `${r.id}: ${r.text} (${tr(w, "en")})`);
  };

  ctx.tools.register([
    {
      name: "set_reminder",
      description: "Programme un rappel ou un minuteur local : à l'heure dite, tu annonces `text` à voix haute. « rappelle-moi dans 10 minutes d'appeler Paul » → text: « appeler Paul », in_minutes: 10. « minuteur 5 minutes » → text: « le minuteur de 5 minutes est terminé », in_minutes: 5. « rappelle-moi demain à 9 h de… » → at: heure locale AAAA-MM-JJTHH:MM (calcule la date depuis la date du jour). Donne soit in_minutes soit at. Refuse le passé et plus d'un an. Rend l'heure prévue : répète-la à l'utilisateur.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Ce qu'il faut rappeler, à la phrase que tu diras." },
          in_minutes: { type: "number", description: "Dans combien de minutes (peut être fractionnaire)." },
          at: { type: "string", description: "Heure locale AAAA-MM-JJTHH:MM." },
        },
        required: ["text"],
      },
      level: "write",
      summary: (a) => {
        const now = clock();
        const due = dueOf(a, now);
        const w = typeof due === "number" ? whenText(due, now) : T("à une heure à préciser", "at a time to be specified");
        return T(`Programmer un rappel « ${String(a.text ?? "")} » ${tr(w, "fr")}`, `Set a reminder "${String(a.text ?? "")}" ${tr(w, "en")}`);
      },
      handler: async (a) => {
        const text = String(a.text ?? "").trim();
        if (!text) return { status: "failed", text: T("Rien à rappeler : le texte est vide.", "Nothing to remind: the text is empty.") };
        const now = clock();
        const due = dueOf(a, now);
        if (typeof due !== "number") return { status: "failed", text: due };
        if (reminders.length >= MAX_REMINDERS) return { status: "failed", text: T(`Trop de rappels en attente (${MAX_REMINDERS}). Annule-en d'abord.`, `Too many pending reminders (${MAX_REMINDERS}). Cancel some first.`) };
        const r: Reminder = { id: `r${++seq}`, text: text.slice(0, 300), due, created: now };
        reminders.push(r);
        try { save(); } catch (e) { reminders.pop(); return { status: "failed", text: T(`Impossible d'enregistrer le rappel : ${String(e)}`, `Could not save the reminder: ${String(e)}`) }; }
        arm();
        const w = whenText(due, now);
        return { status: "done", text: T(`C'est noté (${r.id}) : « ${r.text} », ${tr(w, "fr")}.`, `Done (${r.id}): "${r.text}", ${tr(w, "en")}.`) };
      },
    },
    {
      name: "list_reminders",
      description: "Liste les rappels et minuteurs en attente (id, texte, heure prévue). Pour « quels rappels j'ai ? », « il reste combien sur mon minuteur ? ».",
      inputSchema: { type: "object", properties: {} },
      level: "read",
      handler: async () => {
        const now = clock();
        const list = sorted();
        if (!list.length) return { status: "done", text: T("Aucun rappel en attente.", "No pending reminders.") };
        return { status: "done", text: T(list.map((r) => tr(line(r, now), "fr")).join("\n"), list.map((r) => tr(line(r, now), "en")).join("\n")) };
      },
    },
    {
      name: "cancel_reminder",
      description: "Annule un rappel ou un minuteur en attente. match : l'id (« r3 ») ou des mots du texte (« Paul »). Si plusieurs rappels correspondent, rien n'est annulé : demande lequel (liste avec list_reminders).",
      inputSchema: { type: "object", properties: { match: { type: "string", description: "Id du rappel ou mots de son texte." } }, required: ["match"] },
      level: "write",
      summary: (a) => {
        const r = find(String(a.match ?? ""));
        return r.length === 1
          ? T(`Annuler le rappel « ${r[0]!.text} »`, `Cancel the reminder "${r[0]!.text}"`)
          : T(`Annuler un rappel (« ${String(a.match ?? "")} »)`, `Cancel a reminder ("${String(a.match ?? "")}")`);
      },
      handler: async (a) => {
        const hits = find(String(a.match ?? ""));
        if (!hits.length) return { status: "failed", text: T("Aucun rappel ne correspond.", "No reminder matches.") };
        if (hits.length > 1) {
          const now = clock();
          return { status: "failed", text: T(`Plusieurs rappels correspondent, précise lequel :\n${hits.map((r) => tr(line(r, now), "fr")).join("\n")}`, `Several reminders match, say which one:\n${hits.map((r) => tr(line(r, now), "en")).join("\n")}`) };
        }
        const r = hits[0]!;
        reminders = reminders.filter((x) => x.id !== r.id);
        save();
        return { status: "done", text: T(`Rappel annulé : « ${r.text} ».`, `Reminder cancelled: "${r.text}".`) };
      },
    },
  ]);

  /** L'heure prévue d'après les arguments de l'outil, ou la raison du refus. */
  function dueOf(a: Record<string, unknown>, now: number): number | Text {
    const hasMin = a.in_minutes !== undefined && a.in_minutes !== null && a.in_minutes !== "";
    const hasAt = typeof a.at === "string" && a.at.trim() !== "";
    if (hasMin === hasAt) return T("Donne soit in_minutes, soit at (AAAA-MM-JJTHH:MM).", "Give either in_minutes or at (YYYY-MM-DDTHH:MM).");
    let due: number;
    if (hasMin) {
      const n = Number(a.in_minutes);
      if (!Number.isFinite(n) || n <= 0) return T("in_minutes doit être un nombre positif.", "in_minutes must be a positive number.");
      due = now + Math.round(n * MINUTE);
    } else {
      const p = parseLocalDateTime(String(a.at));
      if (p === undefined) return T("Heure illisible : attendu AAAA-MM-JJTHH:MM (heure locale).", "Unreadable time: expected YYYY-MM-DDTHH:MM (local time).");
      due = p;
    }
    if (due <= now) return T("Cette heure est déjà passée.", "That time has already passed.");
    if (due - now > MAX_AHEAD_MS) return T("Trop lointain : un an au plus.", "Too far ahead: one year at most.");
    return due;
  }
  function find(q: string): Reminder[] {
    const byId = reminders.find((r) => r.id === q.trim().toLowerCase());
    if (byId) return [byId];
    const w = words(q);
    if (!w.length) return [];
    return sorted().filter((r) => { const t = fold(r.text); return w.every((x) => t.includes(x)); });
  }

  // Rattrapage : ce qui est passé pendant l'arrêt est annoncé après le délai de démarrage.
  arm();
  return { list: sorted };
}
