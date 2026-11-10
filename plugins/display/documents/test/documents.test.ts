import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, definePlugin, type DocumentsService } from "@floppy/core";
import type { BodyHub, HubEvent } from "@floppy/contracts";
import type { Capability, KernelToBody } from "@floppy/protocol";
import { createDocumentsPlugin, parse, serialize, slug, isDocId } from "../src/index.ts";

const dirs: string[] = [];
let kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels) await k.stopAll();
  kernels = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Fake = { id: string; caps: Capability[] };

async function fixture(bodies: Fake[] = [], clock = new Date(2026, 10, 6, 9, 5)) {
  const home = mkdtempSync(join(tmpdir(), "docs-"));
  dirs.push(home);
  const sent: { to: string; msg: KernelToBody }[] = [];
  let listener: ((ev: HubEvent) => void) | undefined;
  const hub: BodyHub = {
    attach: () => {}, sendAudio: () => {}, broadcast: () => {},
    sessions: () => bodies.map((b) => ({ id: b.id, name: b.id, capabilities: b.caps, tools: [] })),
    has: (id, cap) => bodies.some((b) => b.id === id && b.caps.includes(cap)),
    send: (to, msg) => { sent.push({ to, msg }); },
    on: (fn) => { listener = fn; return () => { listener = undefined; }; },
  };
  const provider = definePlugin({ manifest: { id: "body", version: "0", licence: "MIT", provides: ["body"] }, apply(c) { c.provide("body", hub); } });
  let t = clock.getTime();
  const k = new Kernel({ logger: () => {}, home, plugins: [provider, createDocumentsPlugin({ now: () => new Date((t += 60_000)) })] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "body", plugin: "body" }, { id: "documents", plugin: "documents" }] });
  const docs = k.service<DocumentsService>("documents")!;
  return { k, home, docs, sent, emit: (ev: HubEvent) => listener?.(ev) };
}

describe("documents : stockage", () => {
  it("save / list / get, avec en-tête relu", async () => {
    const f = await fixture();
    const a = await f.docs.save({ title: "Comparatif Mac/PC : prix", markdown: "# Titre\n\n| a | b |\n|---|---|\n| 1 | 2 |", source: "floppy", tags: ["reponse", "reponse"] });
    expect(a.id).toMatch(/^2026-11-06-\d{4}-comparatif-mac-pc-prix$/);
    expect(a.tags).toEqual(["reponse"]);
    const b = await f.docs.save({ title: "Veille du jour", markdown: "Des liens.", source: "veille", tags: ["veille"] });
    const list = await f.docs.list();
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]); // le plus récent d'abord
    expect((await f.docs.list({ tag: "veille" })).map((x) => x.id)).toEqual([b.id]);
    expect(await f.docs.list({ max: 1 })).toHaveLength(1);
    const g = await f.docs.get(a.id);
    expect(g?.title).toBe("Comparatif Mac/PC : prix");
    expect(g?.markdown).toBe("# Titre\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(g?.date).toBe(a.date);
    expect(readdirSync(join(f.home, "documents"))).toHaveLength(2);
  });

  it("deux documents au même titre et à la même minute : deux fichiers", async () => {
    const f = await fixture();
    const same = () => f.docs.save({ title: "Pareil", markdown: "x", source: "t" });
    const [x, y] = [await same(), await same()];
    expect(x.id).not.toBe(y.id);
  });

  it("l'en-tête fait l'aller-retour (guillemets, deux-points, accents)", () => {
    const ref = { id: "x", title: 'Un "titre": à é', date: "2026-11-06T08:00:00.000Z", source: "veille", tags: ["a b", "c"] };
    const back = parse("x", serialize(ref, "# Corps\n\n---\n\nsuite"));
    expect(back).toEqual({ ...ref, markdown: "# Corps\n\n---\n\nsuite" });
  });

  it("fichier sans en-tête : titre pris au premier titre", () => {
    expect(parse("abc", "# Bonjour\n\ntexte").title).toBe("Bonjour");
    expect(parse("abc", "texte").title).toBe("abc");
  });

  it("ids dangereux refusés", async () => {
    const f = await fixture();
    for (const bad of ["../secret", "a/b", "a\\b", "", ".hidden", "x.md", "a".repeat(300)]) {
      expect(isDocId(bad)).toBe(false);
      expect(await f.docs.get(bad)).toBeUndefined();
      expect(await f.docs.show(bad)).toBeUndefined();
    }
  });

  it("slug sans accents", () => {
    expect(slug("Météo à Paris !")).toBe("meteo-a-paris");
    expect(slug("???")).toBe("document");
  });

  it("fichier écrit en clair avec en-tête", async () => {
    const f = await fixture();
    const a = await f.docs.save({ title: "T", markdown: "corps", source: "floppy", tags: ["reponse"] });
    const raw = readFileSync(join(f.home, "documents", `${a.id}.md`), "utf8");
    expect(raw.startsWith('---\ntitle: "T"\n')).toBe(true);
    expect(raw).toContain('tags: ["reponse"]');
  });
});

describe("documents : où montrer", () => {
  it("cible avec `document` : elle seule reçoit, avec la liste", async () => {
    const f = await fixture([{ id: "avatar", caps: ["voice", "document"] }, { id: "autre", caps: ["document"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m", source: "t" });
    expect(await f.docs.show(a.id, "autre")).toBe("autre");
    expect(f.sent).toHaveLength(1);
    const msg = f.sent[0]!.msg as Extract<KernelToBody, { type: "document" }>;
    expect(f.sent[0]!.to).toBe("autre");
    expect(msg).toMatchObject({ type: "document", id: a.id, title: "Un", markdown: "m" });
    expect(msg.entries?.map((x) => x.id)).toEqual([a.id]);
  });

  it("sans cible (ou cible voix seule) : le premier corps qui sait afficher", async () => {
    const f = await fixture([{ id: "reachy", caps: ["voice"] }, { id: "avatar", caps: ["voice", "document"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m", source: "t" });
    expect(await f.docs.show(a.id)).toBe("avatar");
    expect(await f.docs.show(a.id, "reachy")).toBe("avatar");
  });

  it("corps texte seul : le Markdown arrive comme message normal", async () => {
    const f = await fixture([{ id: "reachy", caps: ["voice"] }, { id: "tg", caps: ["text"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "**m**", source: "t" });
    expect(await f.docs.show(a.id)).toBe("tg");
    expect(f.sent[0]).toEqual({ to: "tg", msg: { type: "reply.done", text: "Un\n\n**m**" } });
  });

  it("origine texte, avatar présent : l'origine reçoit le texte", async () => {
    const f = await fixture([{ id: "avatar", caps: ["document"] }, { id: "tg", caps: ["text"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m", source: "t" });
    expect(await f.docs.show(a.id, "tg")).toBe("tg");
    expect(f.sent.map((s) => s.to)).toEqual(["tg"]);
  });

  it("voix seule : rien n'est envoyé, undefined", async () => {
    const f = await fixture([{ id: "reachy", caps: ["voice"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m", source: "t" });
    expect(await f.docs.show(a.id, "reachy")).toBeUndefined();
    expect(f.sent).toHaveLength(0);
  });

  it("document.open : le corps demandeur reçoit le document ; id inconnu ignoré ; corps sans capacité ignoré", async () => {
    const f = await fixture([{ id: "avatar", caps: ["document"] }, { id: "reachy", caps: ["voice"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m", source: "t" });
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.open", id: a.id } });
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.open", id: "../x" } });
    f.emit({ type: "message", bodyId: "reachy", msg: { type: "document.open", id: a.id } });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.sent.map((s) => [s.to, s.msg.type])).toEqual([["avatar", "document"]]);
  });

  it("document.delete : efface le fichier ; garde le document affiché, sinon montre le plus récent ; rien d'autre n'est touché", async () => {
    const f = await fixture([{ id: "avatar", caps: ["document"] }, { id: "reachy", caps: ["voice"] }]);
    const a = await f.docs.save({ title: "Un", markdown: "m1", source: "t" });
    const b = await f.docs.save({ title: "Deux", markdown: "m2", source: "t" });
    const c = await f.docs.save({ title: "Trois", markdown: "m3", source: "t" });
    const wait = () => new Promise((r) => setTimeout(r, 20));

    // Supprimer un autre document que celui affiché : nouvelle liste seulement.
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.delete", id: a.id, current: c.id } });
    await wait();
    expect(await f.docs.get(a.id)).toBeUndefined();
    expect(f.sent.at(-1)).toEqual({ to: "avatar", msg: { type: "documents", entries: [expect.objectContaining({ id: c.id }), expect.objectContaining({ id: b.id })] } });

    // Supprimer le document affiché : le plus récent qui reste est montré.
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.delete", id: c.id, current: c.id } });
    await wait();
    expect(f.sent.at(-1)?.msg).toMatchObject({ type: "document", id: b.id, markdown: "m2" });

    // Corps sans écran, ou id piégé : rien n'est effacé.
    f.emit({ type: "message", bodyId: "reachy", msg: { type: "document.delete", id: b.id } });
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.delete", id: "../../settings" } });
    await wait();
    expect(await f.docs.get(b.id)).toBeDefined();

    // Le dernier : la fenêtre se vide.
    f.emit({ type: "message", bodyId: "avatar", msg: { type: "document.delete", id: b.id, current: b.id } });
    await wait();
    expect(f.sent.at(-1)?.msg).toEqual({ type: "document", id: "", title: "", markdown: "", entries: [] });
    expect(readdirSync(join(f.home, "documents"))).toHaveLength(0);
  });
});

describe("documents : outils du cerveau", () => {
  it("afficher_document : enregistre (source floppy, tag reponse), montre sur l'origine, demande une phrase", async () => {
    const f = await fixture([{ id: "avatar", caps: ["voice", "document"] }]);
    const r = await f.k.tools.call("afficher_document", { titre: "Comparatif", markdown: "# A\n\n| x |\n|---|\n| 1 |" }, { origin: "avatar" });
    expect(r.status).toBe("done");
    expect(r.text).toMatch(/UNE seule phrase/);
    const [ref] = await f.docs.list();
    expect(ref).toMatchObject({ title: "Comparatif", source: "floppy", tags: ["reponse"] });
    expect(f.sent[0]!.to).toBe("avatar");
  });

  it("afficher_document sans écran : dit de répondre à l'oral", async () => {
    const f = await fixture([{ id: "reachy", caps: ["voice"] }]);
    const r = await f.k.tools.call("afficher_document", { titre: "T", markdown: "m" }, { origin: "reachy" });
    expect(r.status).toBe("done");
    expect(r.text).toMatch(/à l'oral/);
    expect(await f.docs.list()).toHaveLength(1);
  });

  it("afficher_document : document vide refusé", async () => {
    const f = await fixture([{ id: "avatar", caps: ["document"] }]);
    expect((await f.k.tools.call("afficher_document", { titre: "T", markdown: "  " }, { origin: "avatar" })).status).toBe("failed");
  });

  it("ouvrir_document : dernier, date, tag, mots du titre, inconnu", async () => {
    const f = await fixture([{ id: "avatar", caps: ["document"] }]);
    const a = await f.docs.save({ title: "Comparatif abonnements", markdown: "a", source: "floppy", tags: ["reponse"] });
    const v = await f.docs.save({ title: "Veille techno", markdown: "v", source: "veille", tags: ["veille"] });
    const opened = async (quoi: string) => {
      f.sent.length = 0;
      const r = await f.k.tools.call("ouvrir_document", { quoi }, { origin: "avatar" });
      return { r, id: (f.sent[0]?.msg as { id?: string } | undefined)?.id };
    };
    expect((await opened("dernier")).id).toBe(v.id);
    expect((await opened("la veille")).id).toBe(v.id);
    expect((await opened("veille")).id).toBe(v.id);
    expect((await opened("comparatif")).id).toBe(a.id);
    expect((await opened("2026-11-06")).id).toBeDefined();
    expect((await opened("aujourd'hui")).id).toBeDefined();
    const none = await opened("recette de crêpes");
    expect(none.r.status).toBe("failed");
    expect(none.r.text).toMatch(/Les derniers/);
    expect(none.id).toBeUndefined();
  });

  it("lister_documents", async () => {
    const f = await fixture();
    expect((await f.k.tools.call("lister_documents", {})).text).toBe("Aucun document.");
    await f.docs.save({ title: "Veille", markdown: "v", source: "veille", tags: ["veille"] });
    expect((await f.k.tools.call("lister_documents", { tag: "veille" })).text).toMatch(/Veille/);
  });
});
