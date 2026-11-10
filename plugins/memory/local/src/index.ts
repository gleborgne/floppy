// Plugin `memory` : mémoire inspirée de Hermes (voir docs/spec/memoire-skills-ton-langue.md).
// - USER.md (profil) et MEMORY.md (notes de l'assistant) : petits, lisibles, toujours dans le prompt.
// - Historique des conversations dans SQLite FTS5 (node:sqlite), consulté par l'outil search_history.
// - Écriture par l'outil `remember`, niveau write : elle passe par l'accord.
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { definePlugin, errorText, T, TextError, writeFileAtomic } from "@floppy/core";
import type { MemoryService } from "@floppy/contracts";
import { correctionStore } from "./corrections.ts";
import { storeOperation, type StoreReporter } from "./store-audit.ts";
import { dayStartIso, formatExchanges, ftsQuery, searchExchanges } from "./history.ts";

const Config = z.object({
  dir: z.string().optional(),
  userLimit: z.number().default(1400),
  memoryLimit: z.number().default(2200),
});
type Config = z.infer<typeof Config>;

const FILES = { user: "USER.md", notes: "MEMORY.md" } as const;
type Which = keyof typeof FILES;

const lineOf = (current: string): string[] => current.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
/** Une ligne se compare sans la puce « - », sans espaces en trop, sans tenir compte de la casse : mais en entier. */
const key = (s: string): string => s.trim().replace(/^-\s+/, "").replace(/\s+/g, " ").toLowerCase();

/** La ligne visée par remplacer/supprimer : correspondance EXACTE de la ligne entière (pas « la première qui contient »). */
export function findLine(current: string, ancien: string): { index: number; line: string } {
  const lines = lineOf(current);
  const want = key(ancien);
  const idx = want ? lines.findIndex((l) => key(l) === want) : -1;
  if (idx < 0) throw new TextError(T(`ligne introuvable (il faut la ligne entière) : « ${ancien} »`, `Line not found (provide the whole line): “${ancien}”`));
  return { index: idx, line: lines[idx]! };
}

export const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex");

export function applyEdit(current: string, action: string, texte: string, ancien?: string): string {
  const lines = lineOf(current);
  const bullet = (s: string) => (s.startsWith("- ") ? s : `- ${s}`);
  if (action === "add") return [...lines, bullet(texte.trim())].join("\n") + "\n";
  if (action !== "delete" && action !== "replace") throw new TextError(T(`Action inconnue : ${action}`, `Unknown action: ${action}`));
  const idx = findLine(current, ancien ?? texte).index;
  if (action === "delete") lines.splice(idx, 1);
  else if (action === "replace") lines[idx] = bullet(texte.trim());
  return lines.length ? lines.join("\n") + "\n" : "";
}

export default definePlugin<Config>({
  manifest: {
    id: "memory",
    version: "0.1.0",
    licence: "MIT",
    description: T("USER.md, MEMORY.md, historique SQLite FTS5 et corrections contextualisées.", "USER.md, MEMORY.md, SQLite FTS5 history and contextual corrections."),
    provides: ["memory"],
  },
  config: Config,
  apply(ctx, cfg) {
    const report: StoreReporter = (event) => ctx.audit.write({ kind: "memory.store", source: ctx.id, ...event });
    const { path, read, limit, db, corrections, insert, find } = storeOperation(report, "startup", () => {
    const dir = cfg.dir ?? join(ctx.home, "memory");
    mkdirSync(dir, { recursive: true });
    const path = (w: Which) => join(dir, FILES[w]);
    for (const w of Object.keys(FILES) as Which[]) if (!existsSync(path(w))) writeFileAtomic(path(w), "");
    const read = (w: Which) => readFileSync(path(w), "utf8");
    const limit = (w: Which) => (w === "user" ? cfg.userLimit : cfg.memoryLimit);

    const db = new DatabaseSync(join(dir, "history.db"));
    ctx.effect(() => db.close());
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(text, t UNINDEXED, session UNINDEXED, role UNINDEXED, origin UNINDEXED, tokenize='unicode61 remove_diacritics 2')");
    const insert = db.prepare("INSERT INTO history (text, t, session, role, origin) VALUES (?, ?, ?, ?, ?)");
    const find = db.prepare("SELECT text, t, session, role FROM history WHERE history MATCH ? ORDER BY rank LIMIT ?");
    const corrections = correctionStore(db, report);
    return { path, read, limit, db, corrections, insert, find };
    }, (store) => ({ correctionsCount: Number(store.db.prepare("SELECT count(*) AS n FROM memory_corrections").get()!.n) }));

    const service: MemoryService = {
      ...corrections,
      snapshot: (options) => storeOperation(report, "snapshot", () => {
        options?.signal?.throwIfAborted(); return { user: read("user"), memory: read("notes") };
      }, undefined, options, true),
      record: (e, options) => storeOperation(report, "history.record", () => {
        options?.signal?.throwIfAborted(); insert.run(e.text, new Date().toISOString(), e.session, e.role, e.origin ?? "");
      }, () => ({ count: 1 }), options),
      search: (q, n = 5, options) => storeOperation(report, "history.search", () => {
        options?.signal?.throwIfAborted();
        // Requête FTS5 sûre : chaque mot entre guillemets, reliés par OR.
        const fts = ftsQuery(q);
        if (!fts) return [];
        return find.all(fts, n) as { t: string; role: string; text: string; session: string }[];
      }, (rows) => ({ count: rows.length }), options),
    };
    ctx.provide("memory", service);

    // Empreinte du fichier au moment de la demande d'accord, par appel (même arguments) : l'écriture la compare.
    const seen = new Map<string, string>();
    const argsKey = (a: Record<string, unknown>): string => JSON.stringify([a.file, a.action, a.text, a.old ?? null]);

    ctx.tools.register([
      {
        name: "remember",
        description: "Retient durablement une information. file : « user » (profil, préférences de l'utilisateur) ou « notes » (tes notes de travail, leçons). action : add (ajouter), replace (remplacer ; old = texte de la ligne à remplacer) ou delete (supprimer). text : le texte à retenir. À utiliser quand l'utilisateur dit « souviens-toi », « retiens », « oublie ».",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", enum: ["user", "notes"] },
            action: { type: "string", enum: ["add", "replace", "delete"] },
            text: { type: "string" },
            old: { type: "string" },
          },
          required: ["file", "action", "text"],
        },
        level: "write",
        summary: (a) => {
          const w = (a.file === "user" ? "user" : "notes") as Which;
          const file = FILES[w];
          const texte = String(a.text ?? "");
          const cur = read(w);
          seen.set(argsKey(a), hashOf(cur)); // le fichier tel qu'il était quand l'accord a été demandé
          if (a.action === "add") return T(`Retenir dans ${file} : « ${texte} »`, `Remember in ${file}: “${texte}”`);
          try {
            const { line } = findLine(cur, String(a.old ?? texte));
            return a.action === "delete"
              ? T(`Oublier dans ${file} la ligne : « ${line} »`, `Forget this line in ${file}: “${line}”`)
              : T(`Dans ${file}, remplacer « ${line} » par « ${texte} »`, `In ${file}, replace “${line}” with “${texte}”`);
          } catch {
            const old = String(a.old ?? texte);
            return a.action === "delete"
              ? T(`Oublier dans ${file} (ligne introuvable) : « ${old} »`, `Forget in ${file} (line not found): “${old}”`)
              : T(`Remplacer dans ${file} (ligne introuvable) : « ${old} »`, `Replace in ${file} (line not found): “${old}”`);
          }
        },
        handler: async (a, meta) => {
          const w = (a.file === "user" ? "user" : "notes") as Which;
          const before = read(w);
          const approved = seen.get(argsKey(a));
          seen.delete(argsKey(a));
          if (approved && approved !== hashOf(before)) {
            return { status: "failed", text: T(`${FILES[w]} a changé depuis ta demande d'accord : rien n'a été écrit. Recommence.`, `${FILES[w]} changed since approval was requested: nothing was written. Try again.`) };
          }
          let next: string;
          try { next = applyEdit(before, String(a.action), String(a.text ?? ""), a.old ? String(a.old) : undefined); }
          catch (e) { return { status: "failed", text: errorText(e) }; }
          if (next.length > limit(w)) {
            return { status: "failed", text: T(`Mémoire pleine (${next.length}/${limit(w)} caractères). Résume ou supprime d'abord des lignes.`, `Memory is full (${next.length}/${limit(w)} characters). Summarize or remove some lines first.`) };
          }
          storeOperation(report, "markdown.edit", () => writeFileAtomic(path(w), next), () => ({ count: 1, file: FILES[w] }), meta);
          return { status: "done", text: T("C'est retenu.", "Remembered.") };
        },
      },
      {
        name: "search_history",
        description: "Cherche dans les conversations passées avec l'utilisateur. query : mots-clés (facultatifs si since/until donnés). since / until : période, jours AAAA-MM-JJ en heure locale, bornes incluses (calcule-les depuis la date du jour : « hier », « la semaine dernière »). role : « user » (ce que l'utilisateur a dit) ou « assistant » (ce que tu as répondu). limit : nombre d'échanges (5 par défaut, 20 au plus). Chaque résultat est un échange daté : la demande de l'utilisateur ET la réponse qui l'accompagne, du plus ancien au plus récent. Sans mots-clés mais avec une période : les derniers échanges de cette période. Utile pour « qu'est-ce que je t'avais dit sur… », « qu'est-ce que tu m'avais répondu sur… », « de quoi on a parlé hier ».",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            since: { type: "string", description: "AAAA-MM-JJ, local, inclus." },
            until: { type: "string", description: "AAAA-MM-JJ, local, inclus." },
            role: { type: "string", enum: ["user", "assistant"] },
            limit: { type: "number" },
          },
        },
        level: "read",
        handler: async (a, meta) => {
          const query = String(a.query ?? "");
          const day = (v: unknown): string | undefined | null => (v === undefined || v === null || v === "" ? undefined : typeof v === "string" && dayStartIso(v) ? v.trim() : null);
          const since = day(a.since), until = day(a.until);
          if (since === null || until === null) return { status: "failed", text: T("Date illisible : attendu AAAA-MM-JJ (heure locale).", "Unreadable date: expected YYYY-MM-DD (local time).") };
          if (a.role !== undefined && a.role !== "" && a.role !== "user" && a.role !== "assistant") return { status: "failed", text: T("role : « user » ou « assistant ».", "role: \"user\" or \"assistant\".") };
          if (!ftsQuery(query) && !since && !until) return { status: "failed", text: T("Donne des mots-clés ou une période (since / until).", "Give keywords or a period (since / until).") };
          const list = storeOperation(report, "history.search", () => {
            meta.signal?.throwIfAborted();
            return searchExchanges(db, { query, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(a.role === "user" || a.role === "assistant" ? { role: a.role } : {}), limit: Number(a.limit ?? 5) });
          }, (r) => ({ count: r.length }), meta);
          if (!list.length) return { status: "done", text: T("Rien trouvé dans l'historique.", "Nothing found in history.") };
          return { status: "done", text: formatExchanges(list) };
        },
      },
    ]);
  },
});
