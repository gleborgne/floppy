// Plugin `memory` : mémoire inspirée de Hermes (voir docs/spec/memoire-skills-ton-langue.md).
// - USER.md (profil) et MEMORY.md (notes de l'assistant) : petits, lisibles, toujours dans le prompt.
// - Historique des conversations dans SQLite FTS5 (node:sqlite), consulté par l'outil chercher_historique.
// - Écriture par l'outil `memoriser`, niveau write : elle passe par l'accord.
import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { definePlugin, T, type MemoryService } from "@floppy/core";

const Config = z.object({
  dir: z.string().optional(),
  userLimit: z.number().default(1400),
  memoryLimit: z.number().default(2200),
});
type Config = z.infer<typeof Config>;

const FILES = { utilisateur: "USER.md", notes: "MEMORY.md" } as const;
type Which = keyof typeof FILES;

const lineOf = (current: string): string[] => current.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
/** Une ligne se compare sans la puce « - », sans espaces en trop, sans tenir compte de la casse : mais en entier. */
const key = (s: string): string => s.trim().replace(/^-\s+/, "").replace(/\s+/g, " ").toLowerCase();

/** La ligne visée par remplacer/supprimer : correspondance EXACTE de la ligne entière (pas « la première qui contient »). */
export function findLine(current: string, ancien: string): { index: number; line: string } {
  const lines = lineOf(current);
  const want = key(ancien);
  const idx = want ? lines.findIndex((l) => key(l) === want) : -1;
  if (idx < 0) throw new Error(`ligne introuvable (il faut la ligne entière) : « ${ancien} »`);
  return { index: idx, line: lines[idx]! };
}

export const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex");

export function applyEdit(current: string, action: string, texte: string, ancien?: string): string {
  const lines = lineOf(current);
  const bullet = (s: string) => (s.startsWith("- ") ? s : `- ${s}`);
  if (action === "ajouter") return [...lines, bullet(texte.trim())].join("\n") + "\n";
  if (action !== "supprimer" && action !== "remplacer") throw new Error(`action inconnue : ${action}`);
  const idx = findLine(current, ancien ?? texte).index;
  if (action === "supprimer") lines.splice(idx, 1);
  else if (action === "remplacer") lines[idx] = bullet(texte.trim());
  else throw new Error(`action inconnue : ${action}`);
  return lines.length ? lines.join("\n") + "\n" : "";
}

export default definePlugin<Config>({
  manifest: {
    id: "memory",
    version: "0.1.0",
    licence: "MIT",
    description: "USER.md, MEMORY.md et historique SQLite FTS5.",
    provides: ["memory"],
  },
  config: Config,
  apply(ctx, cfg) {
    const dir = cfg.dir ?? join(ctx.home, "memory");
    mkdirSync(dir, { recursive: true });
    const path = (w: Which) => join(dir, FILES[w]);
    for (const w of Object.keys(FILES) as Which[]) if (!existsSync(path(w))) writeFileSync(path(w), "", "utf8");
    const read = (w: Which) => readFileSync(path(w), "utf8");
    const limit = (w: Which) => (w === "utilisateur" ? cfg.userLimit : cfg.memoryLimit);

    const db = new DatabaseSync(join(dir, "history.db"));
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(text, t UNINDEXED, session UNINDEXED, role UNINDEXED, origin UNINDEXED, tokenize='unicode61 remove_diacritics 2')");
    ctx.effect(() => db.close());
    const insert = db.prepare("INSERT INTO history (text, t, session, role, origin) VALUES (?, ?, ?, ?, ?)");
    const find = db.prepare("SELECT text, t, session, role FROM history WHERE history MATCH ? ORDER BY rank LIMIT ?");

    const service: MemoryService = {
      snapshot: () => ({ user: read("utilisateur"), memory: read("notes") }),
      record: (e) => { insert.run(e.text, new Date().toISOString(), e.session, e.role, e.origin ?? ""); },
      search: (q, n = 5) => {
        // Requête FTS5 sûre : chaque mot entre guillemets, reliés par OR.
        const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
        if (!words.length) return [];
        return find.all(words.map((w) => `"${w}"`).join(" OR "), n) as { t: string; role: string; text: string; session: string }[];
      },
    };
    ctx.provide("memory", service);

    // Empreinte du fichier au moment de la demande d'accord, par appel (même arguments) : l'écriture la compare.
    const seen = new Map<string, string>();
    const argsKey = (a: Record<string, unknown>): string => JSON.stringify([a.fichier, a.action, a.texte, a.ancien ?? null]);

    ctx.tools.register([
      {
        name: "memoriser",
        description: "Retient durablement une information. fichier : « utilisateur » (profil, préférences de l'utilisateur) ou « notes » (tes notes de travail, leçons). action : ajouter, remplacer (ancien = texte de la ligne à remplacer) ou supprimer. À utiliser quand l'utilisateur dit « souviens-toi », « retiens », « oublie ».",
        inputSchema: {
          type: "object",
          properties: {
            fichier: { type: "string", enum: ["utilisateur", "notes"] },
            action: { type: "string", enum: ["ajouter", "remplacer", "supprimer"] },
            texte: { type: "string" },
            ancien: { type: "string" },
          },
          required: ["fichier", "action", "texte"],
        },
        level: "write",
        summary: (a) => {
          const w = (a.fichier === "utilisateur" ? "utilisateur" : "notes") as Which;
          const file = FILES[w];
          const texte = String(a.texte ?? "");
          const cur = read(w);
          seen.set(argsKey(a), hashOf(cur)); // le fichier tel qu'il était quand l'accord a été demandé
          if (a.action === "ajouter") return T(`Retenir dans ${file} : « ${texte} »`, `Remember in ${file}: “${texte}”`);
          try {
            const { line } = findLine(cur, String(a.ancien ?? texte));
            return a.action === "supprimer"
              ? T(`Oublier dans ${file} la ligne : « ${line} »`, `Forget this line in ${file}: “${line}”`)
              : T(`Dans ${file}, remplacer « ${line} » par « ${texte} »`, `In ${file}, replace “${line}” with “${texte}”`);
          } catch {
            const old = String(a.ancien ?? texte);
            return a.action === "supprimer"
              ? T(`Oublier dans ${file} (ligne introuvable) : « ${old} »`, `Forget in ${file} (line not found): “${old}”`)
              : T(`Remplacer dans ${file} (ligne introuvable) : « ${old} »`, `Replace in ${file} (line not found): “${old}”`);
          }
        },
        handler: async (a) => {
          const w = (a.fichier === "utilisateur" ? "utilisateur" : "notes") as Which;
          const before = read(w);
          const approved = seen.get(argsKey(a));
          seen.delete(argsKey(a));
          if (approved && approved !== hashOf(before)) {
            return { status: "failed", text: `${FILES[w]} a changé depuis ta demande d'accord : rien n'a été écrit. Recommence.` };
          }
          let next: string;
          try { next = applyEdit(before, String(a.action), String(a.texte ?? ""), a.ancien ? String(a.ancien) : undefined); }
          catch (e) { return { status: "failed", text: e instanceof Error ? e.message : String(e) }; }
          if (next.length > limit(w)) {
            return { status: "failed", text: `Mémoire pleine (${next.length}/${limit(w)} caractères). Résume ou supprime d'abord des lignes.` };
          }
          writeFileSync(path(w), next, "utf8");
          return { status: "done", text: "C'est retenu." };
        },
      },
      {
        name: "chercher_historique",
        description: "Cherche dans les conversations passées avec l'utilisateur (mots-clés). Utile pour « qu'est-ce que je t'avais dit sur… ».",
        inputSchema: { type: "object", properties: { requete: { type: "string" }, limite: { type: "number" } }, required: ["requete"] },
        level: "read",
        handler: async (a) => {
          const rows = service.search(String(a.requete ?? ""), Number(a.limite ?? 5));
          if (!rows.length) return { status: "done", text: "Rien trouvé dans l'historique." };
          return { status: "done", text: rows.map((r) => `${r.t.slice(0, 16)} ${r.role === "user" ? "Utilisateur" : "Assistant"} : ${r.text}`).join("\n") };
        },
      },
    ]);
  },
});
