// Plugin `documents` : des documents Markdown (« artefacts ») que Floppy montre dans une fenêtre.
// - Un document = un fichier `<home>/documents/AAAA-MM-JJ-HHMM-<titre>.md`, avec un petit en-tête (titre, date, source, tags).
//   Son id est le nom du fichier sans « .md ». Les ids sont validés : jamais de chemin.
// - Service `documents` (save, show, list, get) : appelé par les outils ci-dessous, et par le noyau après une tâche.
// - Où montrer un document : le corps demandé, sinon le premier corps qui sait afficher (capacité `document`) ;
//   sinon un corps texte reçoit le Markdown comme message ; sinon rien (corps voix seule : l'appelant dit un résumé).
// - L'utilisateur peut rouvrir un ancien document depuis la liste de la fenêtre (message `document.open` du corps).
import { z } from "zod";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, slugify, wordsKey, type DocRef, type DocumentsService } from "@floppy/core";
import type { DocumentEntry } from "@floppy/protocol";

const Config = z.object({});
type Config = z.infer<typeof Config>;

export interface DocumentsOptions {
  /** Horloge (pour les tests). */
  now?: () => Date;
}

/** Combien de documents récents accompagnent un document affiché (barre de gauche). */
export const LISTE_MAX = 30;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/;

export const isDocId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

// --------------------------------------------------------------------------- en-tête (mini YAML, sans dépendance)

/** Texte du fichier : en-tête puis Markdown. Les valeurs sont écrites en JSON (valide en YAML). */
export function serialize(ref: DocRef, markdown: string): string {
  return `---\ntitre: ${JSON.stringify(ref.titre)}\ndate: ${ref.date}\nsource: ${JSON.stringify(ref.source)}\ntags: ${JSON.stringify(ref.tags)}\n---\n\n${markdown}\n`;
}

/** Relit un fichier. Sans en-tête valide : le texte entier est le Markdown, le titre vient du premier titre ou de l'id. */
export function parse(id: string, text: string): DocRef & { markdown: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const head: Record<string, string> = {};
  let body = text;
  if (m) {
    body = m[2]!.replace(/^\r?\n/, "").replace(/\s+$/, "");
    for (const line of m[1]!.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const str = (k: string): string | undefined => {
    const v = head[k];
    if (v === undefined) return undefined;
    if (v.startsWith('"')) { try { const x: unknown = JSON.parse(v); return typeof x === "string" ? x : undefined; } catch { return undefined; } }
    return v;
  };
  let tags: string[] = [];
  if (head.tags?.startsWith("[")) {
    try { const x: unknown = JSON.parse(head.tags); if (Array.isArray(x)) tags = x.filter((t): t is string => typeof t === "string"); } catch { /* tags ignorés */ }
  }
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const date = head.date && !Number.isNaN(Date.parse(head.date)) ? head.date : new Date(0).toISOString();
  return { id, titre: str("titre") || h1 || id, date, source: str("source") ?? "", tags, markdown: body };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** « Comparatif Mac/PC : prix » → « comparatif-mac-pc-prix » (sans accents, 40 caractères au plus). */
export function slug(titre: string): string {
  const s = slugify(titre).slice(0, 40).replace(/-+$/, "");
  return s || "document";
}

const norm = (s: string): string => wordsKey(s);
const entry = (d: DocRef): DocumentEntry => ({ id: d.id, titre: d.titre, date: d.date, tags: d.tags });

export function createDocumentsPlugin(opts: DocumentsOptions = {}) {
  const now = opts.now ?? (() => new Date());
  return definePlugin<Config>({
    manifest: {
      id: "documents",
      version: "0.1.0",
      licence: "MIT",
      description: "Documents Markdown : Floppy les range et les montre dans une fenêtre.",
      provides: ["documents"],
      optional: ["body"],
    },
    config: Config,
    apply(ctx) {
      const dir = join(ctx.home, "documents");
      mkdirSync(dir, { recursive: true });

      const read = (id: string): (DocRef & { markdown: string }) | undefined => {
        if (!isDocId(id)) return undefined;
        const f = join(dir, `${id}.md`);
        if (!existsSync(f)) return undefined;
        try { return parse(id, readFileSync(f, "utf8")); } catch { return undefined; }
      };

      const service: DocumentsService = {
        async save(doc) {
          const titre = String(doc.titre ?? "").trim().slice(0, 200) || "Document";
          const d = now();
          const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug(titre)}`;
          let id = base;
          for (let n = 2; existsSync(join(dir, `${id}.md`)); n++) id = `${base}-${n}`;
          const tags = [...new Set((doc.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 10);
          const ref: DocRef = { id, titre, date: d.toISOString(), source: String(doc.source ?? "").slice(0, 80), tags };
          writeFileSync(join(dir, `${id}.md`), serialize(ref, String(doc.markdown ?? "").replace(/\s+$/, "")), "utf8");
          return ref;
        },

        async list(filtre) {
          const out: DocRef[] = [];
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".md")) continue;
            const doc = read(f.slice(0, -3));
            if (!doc) continue;
            if (filtre?.tag && !doc.tags.some((t) => norm(t) === norm(filtre.tag!))) continue;
            const { markdown: _m, ...ref } = doc;
            out.push(ref);
          }
          out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
          return out.slice(0, Math.max(1, filtre?.max ?? out.length));
        },

        async get(id) { return read(id); },

        async remove(id) {
          if (!isDocId(id)) return false;
          const f = join(dir, `${id}.md`);
          if (!existsSync(f)) return false;
          unlinkSync(f);
          ctx.audit.write({ kind: "document.remove", id });
          return true;
        },

        async show(id, cible) {
          const hub = ctx.maybe("body");
          if (!hub) return undefined;
          const doc = read(id);
          if (!doc) return undefined;
          const sessions = hub.sessions().filter((s) => s.enabled !== false);
          const withDoc = (b: string) => hub.has(b, "document");
          const withText = (b: string) => hub.has(b, "text");
          let target: string | undefined;
          let asText = false;
          if (cible && sessions.some((s) => s.id === cible) && withDoc(cible)) target = cible;
          else if (cible && sessions.some((s) => s.id === cible) && withText(cible)) { target = cible; asText = true; }
          else {
            target = sessions.find((s) => withDoc(s.id))?.id;
            if (!target) { target = sessions.find((s) => withText(s.id))?.id; asText = true; }
          }
          if (!target) return undefined;
          if (asText) hub.send(target, { type: "reply.done", text: `${doc.titre}\n\n${doc.markdown}` });
          else {
            const liste = (await service.list({ max: LISTE_MAX })).map(entry);
            hub.send(target, { type: "document", id: doc.id, titre: doc.titre, markdown: doc.markdown, liste });
          }
          return target;
        },
      };
      ctx.provide("documents", service);

      // L'utilisateur choisit un ancien document dans la liste de la fenêtre.
      const hub0 = ctx.maybe("body");
      if (hub0) {
        const off = hub0.on((ev) => {
          if (ev.type !== "message" || !hub0.has(ev.bodyId, "document")) return;
          const fail = (e: unknown) => ctx.log("warn", `documents : ${e instanceof Error ? e.message : String(e)}`);
          if (ev.msg.type === "document.open") void service.show(ev.msg.id, ev.bodyId).catch(fail);
          // Suppression depuis la liste (clic, confirmé dans la fenêtre). Le document affiché supprimé : on montre le plus récent.
          if (ev.msg.type === "document.delete") {
            const { id, current } = ev.msg;
            const body = ev.bodyId;
            void (async () => {
              await service.remove!(id);
              const liste = (await service.list({ max: LISTE_MAX })).map(entry);
              if (current && current !== id) { hub0.send(body, { type: "documents", liste }); return; }
              const next = liste[0];
              if (next) await service.show(next.id, body);
              else hub0.send(body, { type: "document", id: "", titre: "", markdown: "", liste: [] });
            })().catch(fail);
          }
        });
        ctx.effect(off);
      }

      /** Quel document veut dire « quoi » : « dernier », une date, « aujourd'hui », un tag ou des mots du titre (français ou anglais). */
      const find = async (quoi: string): Promise<DocRef | undefined> => {
        const all = await service.list();
        const q = norm(quoi);
        if (!q || /^(dernier|derniere|last|recent|le dernier|la derniere|latest|the last|the latest|most recent|the last one|the latest one)$/.test(q)) return all[0];
        const d = now();
        const day = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
        const iso = /\b(\d{4}) (\d{2}) (\d{2})\b/.exec(q);
        let date: string | undefined = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : undefined;
        if (!date && /\baujourd|\btoday\b/.test(q)) date = day(d);
        if (!date && /\bhier\b|\byesterday\b/.test(q)) date = day(new Date(d.getTime() - 86400000));
        if (date) { const hit = all.find((x) => x.id.startsWith(date!)); if (hit) return hit; }
        const byTag = all.find((x) => x.tags.some((t) => norm(t) === q));
        if (byTag) return byTag;
        const words = q.split(" ").filter((w) => w.length > 2);
        let best: DocRef | undefined, bestScore = 0;
        for (const x of all) {
          const t = norm(x.titre);
          const score = words.filter((w) => t.includes(w)).length;
          if (score > bestScore) { best = x; bestScore = score; }
        }
        return best;
      };

      const fmt = (x: DocRef) => `- ${x.titre} (${x.date.slice(0, 10)}${x.tags.length ? `, ${x.tags.join("/")}` : ""})`;

      ctx.tools.register([
        {
          name: "afficher_document",
          description: "Montre une réponse longue (liste, tableau, comparaison, plusieurs liens) dans une fenêtre, en Markdown, et la range dans les documents. titre : court. markdown : le contenu complet (titres, listes, tableaux, liens [texte](https://...)). Ensuite, dis UNE seule phrase courte de résumé : ne lis pas le document.",
          inputSchema: { type: "object", properties: { titre: { type: "string" }, markdown: { type: "string" } }, required: ["titre", "markdown"] },
          level: "read",
          handler: async (a, meta) => {
            const titre = String(a.titre ?? "").trim();
            const markdown = String(a.markdown ?? "").trim();
            if (!markdown) return { status: "failed", text: "Document vide." };
            const ref = await service.save({ titre: titre || "Document", markdown, source: "floppy", tags: ["reponse"] });
            const body = await service.show(ref.id, meta.origin);
            if (!body) return { status: "done", text: "Le document est rangé, mais aucun écran n'est disponible ici. Réponds à l'oral : donne l'essentiel en deux ou trois phrases courtes." };
            const hub = ctx.maybe("body");
            if (hub?.has(body, "document")) return { status: "done", text: `Le document « ${ref.titre} » est affiché dans une fenêtre. Dis UNE seule phrase courte de résumé, sans lire le contenu.` };
            return { status: "done", text: `Le document « ${ref.titre} » est envoyé en message texte. Dis UNE seule phrase courte de résumé.` };
          },
        },
        {
          name: "ouvrir_document",
          description: "Rouvre un ancien document dans la fenêtre. quoi : « dernier », une date (2026-11-06, aujourd'hui, hier), un tag (« veille ») ou des mots du titre.",
          inputSchema: { type: "object", properties: { quoi: { type: "string" } }, required: ["quoi"] },
          level: "read",
          handler: async (a, meta) => {
            const x = await find(String(a.quoi ?? ""));
            if (!x) {
              const recent = (await service.list({ max: 5 })).map(fmt).join("\n");
              return { status: "failed", text: `Aucun document ne correspond.${recent ? `\nLes derniers :\n${recent}` : " Il n'y a encore aucun document."}` };
            }
            const body = await service.show(x.id, meta.origin);
            if (!body) return { status: "done", text: `J'ai trouvé « ${x.titre} » mais je n'ai pas d'écran pour le montrer. Dis simplement que tu as ce document.` };
            return { status: "done", text: `Le document « ${x.titre} » (${x.date.slice(0, 10)}) est affiché. Dis une phrase courte, sans le lire.` };
          },
        },
        {
          name: "lister_documents",
          description: "Liste les derniers documents rangés (titre et date). tag : pour filtrer (par exemple « veille »).",
          inputSchema: { type: "object", properties: { tag: { type: "string" } } },
          level: "read",
          handler: async (a) => {
            const tag = a.tag ? String(a.tag) : undefined;
            const list = await service.list({ ...(tag ? { tag } : {}), max: 10 });
            return { status: "done", text: list.length ? list.map(fmt).join("\n") : "Aucun document." };
          },
        },
      ]);
    },
  });
}

export default createDocumentsPlugin();
