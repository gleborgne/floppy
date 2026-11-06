import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DownloadManager, MemorySecrets, hostAllowed, Kernel, definePlugin, tr, type DownloadState, type Context } from "../src/index.ts";
import { safeJoin } from "../src/downloads.ts";

const quiet = () => {};
const DATA = randomBytes(200_000);
const SHA = createHash("sha256").update(DATA).digest("hex");

interface Srv { url: string; server: Server; ranges: (string | undefined)[]; mode: { cutAt?: number; noRange?: boolean; status?: number; hold?: boolean } }
let servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); servers = []; });

/** Petit serveur local : sert DATA, comprend Range, peut couper la connexion ou rester bloqué. */
async function serve(): Promise<Srv> {
  const srv = { ranges: [], mode: {} } as unknown as Srv;
  const server = createServer((req, res) => {
    srv.ranges.push(req.headers.range);
    if (srv.mode.status) { res.writeHead(srv.mode.status); res.end(); return; }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (m && !srv.mode.noRange) {
      start = Number(m[1]);
      if (start >= DATA.length) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, { "content-length": DATA.length - start, "content-range": `bytes ${start}-${DATA.length - 1}/${DATA.length}` });
    } else res.writeHead(200, { "content-length": DATA.length });
    if (srv.mode.hold) { res.write(DATA.subarray(start, start + 1000)); return; } // ne finit jamais
    const cut = srv.mode.cutAt;
    if (cut !== undefined && cut > start) { res.write(DATA.subarray(start, cut)); setTimeout(() => res.destroy(), 20); return; }
    res.end(DATA.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  srv.server = server;
  srv.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return srv;
}

const dir = () => mkdtempSync(join(tmpdir(), "floppy-dl-"));
const HOSTS = ["127.0.0.1"];

/** Attend la fin d'un téléchargement (done, error, cancelled). */
function finished(m: DownloadManager, key: string): Promise<DownloadState> {
  return new Promise((resolve) => {
    const off = m.onChange((s) => { if (s.key === key && (s.state === "done" || s.state === "error" || s.state === "cancelled")) { off(); resolve(s); } });
  });
}

describe("hostAllowed / safeJoin", () => {
  it("compare les hôtes exactement ou par « *. »", () => {
    expect(hostAllowed(["huggingface.co"], "huggingface.co")).toBe(true);
    expect(hostAllowed(["huggingface.co"], "evil-huggingface.co")).toBe(false);
    expect(hostAllowed(["*.hf.co"], "cdn-lfs.hf.co")).toBe(true);
    expect(hostAllowed(["*.hf.co"], "hf.co")).toBe(true);
    expect(hostAllowed(["*.hf.co"], "nothf.co")).toBe(false);
    expect(hostAllowed(undefined, "huggingface.co")).toBe(false);
  });
  it("refuse un chemin qui sort du dossier", () => {
    const d = dir();
    expect(safeJoin(d, "a/b.onnx")).toBe(join(d, "a", "b.onnx"));
    expect(() => safeJoin(d, "../x")).toThrow(/refusé/);
    expect(() => safeJoin(d, "a/../../x")).toThrow(/refusé/);
    expect(() => safeJoin(d, "")).toThrow(/refusé/);
  });
});

describe("DownloadManager", () => {
  it("télécharge, annonce la progression, vérifie le sha256 et ne laisse pas de .part", async () => {
    const s = await serve();
    const d = dir();
    const m = new DownloadManager({ tickMs: 0 });
    const seen: DownloadState[] = [];
    m.onChange((x) => seen.push(x));
    const end = finished(m, "e/k");
    const first = m.start("e/k", { key: "k", label: "Modèle", files: [{ url: `${s.url}/f`, path: "m/f.bin", size: DATA.length, sha256: SHA }] }, d, HOSTS);
    expect(first).toMatchObject({ state: "running", total: DATA.length }); // une place libre : lancé tout de suite
    expect(await end).toMatchObject({ state: "done", received: DATA.length, total: DATA.length });
    expect(readFileSync(join(d, "m/f.bin")).equals(DATA)).toBe(true);
    expect(existsSync(join(d, "m/f.bin.part"))).toBe(false);
    expect(seen.map((x) => x.state)).toContain("running");
  });

  it("apprend la taille par content-length quand elle n'est pas donnée", async () => {
    const s = await serve();
    const m = new DownloadManager();
    const end = finished(m, "k");
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f" }] }, dir(), HOSTS);
    expect(await end).toMatchObject({ state: "done", total: DATA.length });
  });

  it("reprend un fichier coupé avec Range", async () => {
    const s = await serve();
    const d = dir();
    const m = new DownloadManager();
    s.mode.cutAt = 50_000;
    const req = { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f", size: DATA.length, sha256: SHA }] };
    let end = finished(m, "k");
    m.start("k", req, d, HOSTS);
    const failed = await end;
    expect(failed.state).toBe("error");
    expect(tr(failed.error, "fr")).toMatch(/échoué/);
    expect(readFileSync(join(d, "f.part")).length).toBe(50_000);
    s.mode.cutAt = undefined;
    end = finished(m, "k");
    m.start("k", req, d, HOSTS);
    expect((await end).state).toBe("done");
    expect(s.ranges.at(-1)).toBe("bytes=50000-");
    expect(readFileSync(join(d, "f")).equals(DATA)).toBe(true);
  });

  it("recommence depuis le début si le serveur ignore Range", async () => {
    const s = await serve();
    const d = dir();
    writeFileSync(join(d, "f.part"), DATA.subarray(0, 1000));
    s.mode.noRange = true;
    const m = new DownloadManager();
    const end = finished(m, "k");
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f", sha256: SHA }] }, d, HOSTS);
    expect((await end).state).toBe("done");
    expect(readFileSync(join(d, "f")).equals(DATA)).toBe(true);
  });

  it("jette un fichier abîmé (sha256 différent)", async () => {
    const s = await serve();
    const d = dir();
    const m = new DownloadManager();
    const end = finished(m, "k");
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f", sha256: "00".repeat(32) }] }, d, HOSTS);
    const r = await end;
    expect(r.state).toBe("error");
    expect(tr(r.error, "en")).toMatch(/damaged/);
    expect(existsSync(join(d, "f"))).toBe(false);
    expect(existsSync(join(d, "f.part"))).toBe(false);
  });

  it("garde un fichier déjà là de la bonne taille sans rien demander", async () => {
    const s = await serve();
    const d = dir();
    writeFileSync(join(d, "f"), DATA);
    const m = new DownloadManager();
    const end = finished(m, "k");
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f", size: DATA.length }] }, d, HOSTS);
    expect((await end).state).toBe("done");
    expect(s.ranges).toHaveLength(0);
  });

  it("signale une réponse d'erreur du serveur", async () => {
    const s = await serve();
    s.mode.status = 404;
    const m = new DownloadManager();
    const end = finished(m, "k");
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f" }] }, dir(), HOSTS);
    const r = await end;
    expect(r.state).toBe("error");
    expect(tr(r.error, "fr")).toMatch(/404/);
  });

  it("annule : arrête et jette le fichier partiel", async () => {
    const s = await serve();
    s.mode.hold = true;
    const d = dir();
    const m = new DownloadManager({ tickMs: 0 });
    const end = finished(m, "k");
    const started = new Promise<void>((r) => { const off = m.onChange((x) => { if (x.received > 0) { off(); r(); } }); });
    m.start("k", { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f" }] }, d, HOSTS);
    await started;
    m.cancel("k");
    expect((await end).state).toBe("cancelled");
    expect(existsSync(join(d, "f.part"))).toBe(false);
  });

  it("n'en lance que `max` à la fois ; les autres attendent", async () => {
    const s = await serve();
    s.mode.hold = true;
    const m = new DownloadManager({ max: 2 });
    const d = dir();
    for (const k of ["a", "b", "c"]) m.start(k, { key: k, label: k, files: [{ url: `${s.url}/${k}`, path: k }] }, d, HOSTS);
    expect(m.list().map((x) => x.state)).toEqual(["running", "running", "queued"]);
    const end = finished(m, "a");
    m.cancel("a");
    await end;
    expect(m.get("c")?.state).toBe("running");
    m.cancel("b"); m.cancel("c");
  });

  it("refuse un site non permis et une adresse qui n'est pas http(s)", () => {
    const m = new DownloadManager();
    expect(() => m.start("k", { key: "k", label: "x", files: [{ url: "https://example.com/f", path: "f" }] }, dir(), ["huggingface.co"])).toThrow(/example\.com/);
    expect(() => m.start("k", { key: "k", label: "x", files: [{ url: "file:///etc/passwd", path: "f" }] }, dir(), ["*"])).toThrow(/invalide/);
  });

  it("rend l'état courant si on relance un téléchargement en cours", async () => {
    const s = await serve();
    s.mode.hold = true;
    const m = new DownloadManager();
    const req = { key: "k", label: "x", files: [{ url: `${s.url}/f`, path: "f" }] };
    m.start("k", req, dir(), HOSTS);
    expect(m.start("k", req, dir(), HOSTS).state).toBe("running");
    expect(m.list()).toHaveLength(1);
    m.cancel("k");
  });
});

describe("ctx.downloads", () => {
  it("range dans <dossier des modèles>/<entrée>, préfixe les clés et annonce la fin", async () => {
    const s = await serve();
    let ctx!: Context;
    const p = definePlugin({
      manifest: { id: "pdl", version: "0", licence: "MIT", permissions: { net: ["127.0.0.1"] } },
      config: z.object({}),
      apply(c) { ctx = c; },
    });
    const home = dir();
    mkdirSync(home, { recursive: true });
    const k = new Kernel({ logger: quiet, plugins: [p], home, secrets: new MemorySecrets() });
    await k.applyConfig({ plugins: [{ id: "dl", plugin: "pdl" }], services: {} });
    expect(ctx.downloads.dir).toBe(join(home, "models", "dl"));
    const states: DownloadState[] = [];
    ctx.downloads.onChange((x) => states.push(x));
    const cards: string[] = [];
    k.bus.on("initiative", (x) => cards.push(x.text));
    const done = new Promise<void>((r) => ctx.downloads.onChange((x) => { if (x.state === "done") r(); }));
    expect(ctx.downloads.start({ key: "vad", label: { fr: "Silero", en: "Silero" }, files: [{ url: `${s.url}/f`, path: "vad.onnx" }] }).key).toBe("vad");
    await done;
    expect(states.every((x) => x.key === "vad")).toBe(true);
    expect(ctx.downloads.get("vad")?.state).toBe("done");
    expect(existsSync(join(home, "models", "dl", "vad.onnx"))).toBe(true);
    expect(cards).toEqual(["Silero est téléchargé."]);
  });

  it("refuse un site absent de permissions.net", async () => {
    let ctx!: Context;
    const p = definePlugin({ manifest: { id: "pnone", version: "0", licence: "MIT" }, config: z.object({}), apply(c) { ctx = c; } });
    const k = new Kernel({ logger: quiet, plugins: [p] });
    await k.applyConfig({ plugins: [{ id: "x", plugin: "pnone" }], services: {} });
    expect(() => ctx.downloads.start({ key: "k", label: "x", files: [{ url: "https://huggingface.co/a", path: "a" }] })).toThrow(/permissions\.net/);
  });
});
