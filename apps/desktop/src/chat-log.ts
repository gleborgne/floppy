// Journal de la fenêtre « Conversation » : calcul pur, testé sans Electron.
// - cleanChatEvent : ce que la page de l'avatar relaie est relu champ par champ (rien n'est cru sur parole).
// - createChatLog : le journal en mémoire (jamais sur disque), borné ; chaque événement rend ce qui change.
// Seule la réponse terminée est rendue en Markdown (par le processus principal) : la fenêtre ne reçoit que du HTML nettoyé.

export const CHAT_MAX = 200;                 // entrées gardées (les plus anciennes partent)
export const REPLY_MAX = 100_000;            // caractères d'une réponse
const LONG_CHARS = 600;
const LONG_LINES = 12;

export interface ChatOption { id: string; label: string; detail?: string }

/** Événement relayé par la page de l'avatar, une fois nettoyé : même nom que le message du noyau. */
export type ChatEvent =
  | { type: "transcript"; text: string }
  | { type: "reply.delta"; text: string }
  | { type: "reply.done"; text: string }
  | { type: "notify"; text: string; important: boolean }
  | { type: "card"; title: string; text: string }
  | { type: "error"; text: string }
  | { type: "approval.request"; id: string; summary: string; ttl_s: number }
  | { type: "approval.closed"; id: string; ok: boolean }
  | { type: "choice.request"; id: string; title: string; options: ChatOption[]; ttl_s: number }
  | { type: "choice.closed"; id: string; picked: string }
  /** Nouvelle connexion au noyau : les demandes en attente n'existent plus. */
  | { type: "session.reset" };

export type ChatEntry =
  | { id: number; kind: "you"; text: string }
  | { id: number; kind: "reply"; text: string; html: string; done: boolean }
  | { id: number; kind: "info"; title: string; text: string; important: boolean }
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "approval"; key: string; summary: string; ttl_s: number; at: number; outcome: "pending" | "yes" | "no" }
  | { id: number; kind: "choice"; key: string; title: string; options: ChatOption[]; ttl_s: number; at: number; closed: boolean; picked: string };

/** Ce qui change après un événement : copies des entrées créées ou modifiées (par id) et ids de celles qui sont parties. */
export interface ChatDelta { changed: ChatEntry[]; removed: number[] }

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const rawId = (v: unknown): string => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : "");
const ttl = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 1), 3600) : 60);

/** Relire un événement venu de la page : null s'il est invalide ou s'il n'est pas pour la conversation. */
export function cleanChatEvent(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "transcript": return m.final === true && str(m.text, 10000).trim() ? { type: "transcript", text: str(m.text, 10000) } : null;
    case "reply.delta": return typeof m.text === "string" && m.text ? { type: "reply.delta", text: str(m.text, REPLY_MAX) } : null;
    case "reply.done": return { type: "reply.done", text: str(m.text, REPLY_MAX) };
    case "notify": return str(m.text, 10000).trim() ? { type: "notify", text: str(m.text, 10000), important: m.important === true } : null;
    case "card": {
      const lines = Array.isArray(m.lines) ? m.lines.slice(0, 100).filter((l): l is string => typeof l === "string").join("\n") : "";
      return { type: "card", title: str(m.title, 300), text: lines.slice(0, 10000) };
    }
    case "error": return str(m.text, 10000).trim() ? { type: "error", text: str(m.text, 10000) } : null;
    case "approval.request": return rawId(m.id) ? { type: "approval.request", id: rawId(m.id), summary: str(m.summary, 2000), ttl_s: ttl(m.ttl_s) } : null;
    case "approval.closed": return rawId(m.id) ? { type: "approval.closed", id: rawId(m.id), ok: m.ok === true } : null;
    case "choice.request": {
      if (!rawId(m.id) || !Array.isArray(m.options)) return null;
      const options: ChatOption[] = [];
      for (const o of m.options.slice(0, 50)) {
        const r = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
        const id = rawId(r.id);
        if (!id || options.some((x) => x.id === id)) continue;
        const detail = str(r.detail, 400);
        options.push({ id, label: str(r.label, 200), ...(detail ? { detail } : {}) });
      }
      return options.length ? { type: "choice.request", id: rawId(m.id), title: str(m.title, 300), options, ttl_s: ttl(m.ttl_s) } : null;
    }
    case "choice.closed": return rawId(m.id) ? { type: "choice.closed", id: rawId(m.id), picked: rawId(m.picked) } : null;
    case "session.reset": return { type: "session.reset" };
    default: return null;
  }
}

/** Une réponse assez longue pour mériter d'ouvrir la fenêtre d'elle-même (plus de 600 caractères ou de 12 lignes). */
export function isLongReply(text: string): boolean {
  return text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
}

export interface ChatLogEnv {
  /** Markdown → HTML nettoyé (renderMarkdown). */
  render(markdown: string): string;
  now(): number;
}

export interface ChatLog {
  entries(): ChatEntry[];
  apply(event: ChatEvent): ChatDelta;
}

export function createChatLog(env: ChatLogEnv): ChatLog {
  let entries: ChatEntry[] = [];
  let nextId = 1;

  const openReply = (): Extract<ChatEntry, { kind: "reply" }> | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.kind === "reply") return e.done ? undefined : e;
    }
    return undefined;
  };
  /** Ajoute une entrée, puis garde les CHAT_MAX plus récentes. */
  const add = (delta: ChatDelta, entry: ChatEntry): void => {
    entries.push(entry);
    delta.changed.push({ ...entry });
    while (entries.length > CHAT_MAX) delta.removed.push(entries.shift()!.id);
  };
  const finish = (delta: ChatDelta, r: Extract<ChatEntry, { kind: "reply" }>): void => {
    r.done = true;
    r.html = env.render(r.text);
    delta.changed.push({ ...r });
  };

  function apply(event: ChatEvent): ChatDelta {
    const delta: ChatDelta = { changed: [], removed: [] };
    switch (event.type) {
      case "transcript": {
        const open = openReply();
        if (open) finish(delta, open);   // une réponse jamais terminée (interrompue) ne reste pas ouverte
        add(delta, { id: nextId++, kind: "you", text: event.text });
        break;
      }
      case "reply.delta": {
        const open = openReply();
        if (open) { open.text = (open.text + event.text).slice(0, REPLY_MAX); delta.changed.push({ ...open }); }
        else add(delta, { id: nextId++, kind: "reply", text: event.text, html: "", done: false });
        break;
      }
      case "reply.done": {
        const open = openReply();
        const text = (event.text || open?.text || "").trim();
        if (!text) {
          if (open) { entries = entries.filter((e) => e !== open); delta.removed.push(open.id); }
          break;
        }
        if (open) { open.text = text; finish(delta, open); }
        else add(delta, { id: nextId++, kind: "reply", text, html: env.render(text), done: true });
        break;
      }
      case "notify": add(delta, { id: nextId++, kind: "info", title: "", text: event.text, important: event.important }); break;
      case "card": add(delta, { id: nextId++, kind: "info", title: event.title, text: event.text, important: false }); break;
      case "error": add(delta, { id: nextId++, kind: "error", text: event.text }); break;
      case "approval.request":
        if (!entries.some((e) => e.kind === "approval" && e.key === event.id))
          add(delta, { id: nextId++, kind: "approval", key: event.id, summary: event.summary, ttl_s: event.ttl_s, at: env.now(), outcome: "pending" });
        break;
      case "approval.closed": {
        const a = entries.find((e) => e.kind === "approval" && e.key === event.id && e.outcome === "pending");
        if (a?.kind === "approval") { a.outcome = event.ok ? "yes" : "no"; delta.changed.push({ ...a }); }
        break;
      }
      case "choice.request":
        if (!entries.some((e) => e.kind === "choice" && e.key === event.id))
          add(delta, { id: nextId++, kind: "choice", key: event.id, title: event.title, options: event.options, ttl_s: event.ttl_s, at: env.now(), closed: false, picked: "" });
        break;
      case "choice.closed": {
        const c = entries.find((e) => e.kind === "choice" && e.key === event.id && !e.closed);
        if (c?.kind === "choice") { c.closed = true; c.picked = event.picked; delta.changed.push({ ...c }); }
        break;
      }
      case "session.reset":
        for (const e of entries) {
          if (e.kind === "approval" && e.outcome === "pending") { e.outcome = "no"; delta.changed.push({ ...e }); }
          else if (e.kind === "choice" && !e.closed) { e.closed = true; delta.changed.push({ ...e }); }
        }
        break;
    }
    return delta;
  }

  return { entries: () => entries, apply };
}
