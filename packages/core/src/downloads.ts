// Téléchargements de fichiers (modèles, voix) pour les plugins. Voir docs/spec/telechargements.md.
// Le noyau ne connaît aucun site ni aucun modèle : il télécharge des fichiers dans le dossier d'un plugin,
// reprend un fichier coupé (en-tête Range), vérifie le sha256 et ne montre le fichier qu'une fois complet.
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { T, TextError, errorText, tr, type Text } from "./i18n.ts";

export interface DownloadFile {
  url: string;
  /** Chemin relatif au dossier du plugin (ex. "parakeet/encoder.int8.onnx"). */
  path: string;
  /** Taille attendue en octets (affiche le total tout de suite ; un fichier déjà là de cette taille est gardé). */
  size?: number;
  /** Empreinte attendue (hexadécimal). Différente : le fichier est jeté et le téléchargement échoue. */
  sha256?: string;
  /**
   * Archive (.zip, .tar.gz) à décompresser dans ce dossier (relatif au dossier du plugin), une fois tous les fichiers
   * reçus et vérifiés. Plusieurs archives peuvent aller dans le même dossier. L'archive est ensuite effacée ; le dossier
   * n'apparaît qu'une fois tout décompressé (un ancien dossier est remplacé).
   */
  extract?: string;
}

export interface DownloadRequest {
  /** Unique dans le plugin (ex. "silero-vad"). */
  key: string;
  label: Text;
  files: DownloadFile[];
}

export type DownloadPhase = "queued" | "running" | "done" | "error" | "cancelled";

export interface DownloadState {
  key: string;
  label: Text;
  state: DownloadPhase;
  /** Octets reçus (tous fichiers). */
  received: number;
  /** Total en octets, quand il est connu. */
  total?: number;
  error?: Text;
  /** Nouvel essai en cours après une coupure (1, 2…) : la reprise garde ce qui est déjà reçu. */
  retry?: number;
}

/** Ce que les plugins voient (ctx.downloads). Les clés sont celles du plugin, sans préfixe. */
export interface ContextDownloads {
  /** Dossier des fichiers téléchargés de ce plugin (<dossier des modèles>/<entrée>). */
  readonly dir: string;
  /** Lance (ou relance) un téléchargement et rend la main tout de suite. Déjà en cours : rend l'état actuel. */
  start(req: DownloadRequest): DownloadState;
  get(key: string): DownloadState | undefined;
  /** Arrête un téléchargement et jette ses fichiers partiels. */
  cancel(key: string): void;
  /** Un état a changé (au plus quelques fois par seconde pendant un téléchargement). */
  onChange(fn: (state: DownloadState) => void): void;
}

interface Job {
  state: DownloadState;
  files: { url: string; dest: string; size?: number; sha256?: string; extract?: string }[];
  abort: AbortController;
}

export interface DownloadManagerOptions {
  fetch?: typeof fetch;
  /** Téléchargements en même temps (défaut : 2). Les autres attendent. */
  max?: number;
  /** Intervalle minimal entre deux annonces de progression, en ms (défaut : 250). */
  tickMs?: number;
  /** Décompresse une archive dans un dossier (tests : simulé). Défaut : le programme tar du système. */
  extract?: (archive: string, dir: string) => Promise<void>;
  /** Attentes avant chaque nouvel essai après une panne (réseau coupé, serveur en panne). Défaut : 5 s, 30 s, 2 min. */
  retryMs?: number[];
}

/** Panne qui ne passera pas en réessayant (adresse introuvable, accès refusé). */
class Permanent extends TextError {}

/**
 * Décompresse avec le tar du système : il lit .zip et .tar.gz (bsdtar sous windows et mac, GNU tar sous linux pour
 * .tar.gz). Sous windows, celui du système (un autre tar du PATH ne lit pas les .zip). tar refuse les chemins absolus
 * et « .. » des archives.
 */
export function systemExtract(archive: string, dir: string): Promise<void> {
  const root = process.env.SystemRoot ?? process.env.windir;
  const tar = process.platform === "win32" && root ? join(root, "System32", "tar.exe") : "tar";
  return new Promise((ok, fail) => {
    execFile(tar, ["-xf", archive, "-C", dir], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) fail(new TextError(T(`décompression impossible : ${String(stderr || err.message).trim().slice(0, 200)}`, `could not unpack: ${String(stderr || err.message).trim().slice(0, 200)}`)));
      else ok();
    });
  });
}

const PART = ".part";

/** Vrai si `host` est permis par une liste du manifeste (« huggingface.co », « *.hf.co »). */
export function hostAllowed(patterns: string[] | undefined, host: string): boolean {
  const h = host.toLowerCase();
  return (patterns ?? []).some((p) => {
    const q = p.toLowerCase();
    if (q === "*") return true;
    if (q.startsWith("*.")) return h.endsWith(q.slice(1)) || h === q.slice(2);
    return h === q;
  });
}

/** Chemin final d'un fichier, refusé s'il sort du dossier (« .. », chemin absolu). */
export function safeJoin(dir: string, rel: string): string {
  const dest = resolve(dir, rel);
  const r = relative(resolve(dir), dest);
  if (!rel || isAbsolute(rel) || r === "" || r.startsWith("..") || isAbsolute(r)) {
    throw new TextError(T(`chemin de fichier refusé : ${rel}`, `file path refused: ${rel}`));
  }
  return dest;
}

const sizeOf = (f: string): number | undefined => { try { return statSync(f).size; } catch { return undefined; } };

async function sha256Of(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Registre des téléchargements de tout le noyau (une seule file pour tous les plugins). */
export class DownloadManager {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<(s: DownloadState) => void>();
  private readonly fetch: typeof fetch;
  private readonly max: number;
  private readonly tickMs: number;
  private readonly extract: (archive: string, dir: string) => Promise<void>;
  private running = 0;
  private readonly retryMs: number[];

  constructor(opts: DownloadManagerOptions = {}) {
    this.retryMs = opts.retryMs ?? [5_000, 30_000, 120_000];
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.max = opts.max ?? 2;
    this.tickMs = opts.tickMs ?? 250;
    this.extract = opts.extract ?? systemExtract;
  }

  /**
   * `key` : clé complète (« <entrée>/<clé> »). `dir` : dossier du plugin. `hosts` : permissions.net du manifeste.
   * Seul l'hôte de l'adresse donnée est vérifié : les redirections (CDN) sont choisies par ce serveur permis.
   */
  start(key: string, req: DownloadRequest, dir: string, hosts: string[] | undefined): DownloadState {
    const cur = this.jobs.get(key);
    if (cur && (cur.state.state === "queued" || cur.state.state === "running")) return { ...cur.state };
    if (!req.files.length) throw new TextError(T("rien à télécharger", "nothing to download"));
    const files = req.files.map((f) => {
      let url: URL;
      try { url = new URL(f.url); } catch { throw new TextError(T(`adresse invalide : ${f.url}`, `invalid address: ${f.url}`)); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new TextError(T(`adresse invalide : ${f.url}`, `invalid address: ${f.url}`));
      if (!hostAllowed(hosts, url.hostname)) {
        throw new TextError(T(`le site ${url.hostname} n'est pas permis (permissions.net du manifeste)`,
          `the site ${url.hostname} is not allowed (manifest permissions.net)`));
      }
      return {
        url: url.href, dest: safeJoin(dir, f.path), ...(f.size !== undefined ? { size: f.size } : {}), ...(f.sha256 ? { sha256: f.sha256.toLowerCase() } : {}),
        ...(f.extract ? { extract: safeJoin(dir, f.extract) } : {}),
      };
    });
    const known = files.every((f) => f.size !== undefined);
    const job: Job = {
      state: { key, label: req.label, state: "queued", received: 0, ...(known ? { total: files.reduce((n, f) => n + f.size!, 0) } : {}) },
      files,
      abort: new AbortController(),
    };
    this.jobs.set(key, job);
    this.emit(job);
    this.pump();
    return { ...job.state };
  }

  get(key: string): DownloadState | undefined {
    const j = this.jobs.get(key);
    return j ? { ...j.state } : undefined;
  }

  list(prefix = ""): DownloadState[] {
    return [...this.jobs.values()].filter((j) => j.state.key.startsWith(prefix)).map((j) => ({ ...j.state }));
  }

  cancel(key: string): void {
    const j = this.jobs.get(key);
    if (!j || (j.state.state !== "queued" && j.state.state !== "running")) return;
    const wasQueued = j.state.state === "queued";
    j.state.state = "cancelled";
    j.abort.abort();
    if (wasQueued) this.emit(j);
    // En cours : run() voit l'arrêt, jette les fichiers partiels et annonce.
  }

  onChange(fn: (s: DownloadState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(j: Job): void {
    const s = { ...j.state };
    for (const fn of this.listeners) { try { fn(s); } catch { /* un abonné ne casse pas les autres */ } }
  }

  private pump(): void {
    while (this.running < this.max) {
      const next = [...this.jobs.values()].find((j) => j.state.state === "queued");
      if (!next) return;
      this.running++;
      next.state.state = "running";
      this.emit(next);
      // La fin est annoncée après avoir lancé le suivant : un abonné voit la file à jour.
      void this.run(next).finally(() => { this.running--; this.pump(); this.emit(next); });
    }
  }

  private async run(j: Job): Promise<void> {
    let last = 0;
    const tick = (force = false) => {
      const now = Date.now();
      if (force || now - last >= this.tickMs) { last = now; this.emit(j); }
    };
    // Une panne (réseau coupé, serveur en panne, fichier abîmé) : quelques nouveaux essais, en reprenant où on en était.
    for (let attempt = 0; ; attempt++) {
      let done = 0; // octets des fichiers déjà finis
      try {
        for (const f of j.files) {
          done += await this.file(j, f, (got) => { j.state.received = done + got; tick(); });
          j.state.received = done;
        }
        await this.unpack(j);
        delete j.state.retry;
        j.state.state = "done";
        return;
      } catch (e) {
        if (!j.abort.signal.aborted && !(e instanceof Permanent) && attempt < this.retryMs.length) {
          j.state.retry = attempt + 1;
          tick(true);
          await new Promise<void>((ok) => {
            const t = setTimeout(ok, this.retryMs[attempt]);
            j.abort.signal.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true });
          });
          if (!j.abort.signal.aborted) continue;
        }
        if (j.abort.signal.aborted) {
          j.state.state = "cancelled";
          for (const f of j.files) rmSync(f.dest + PART, { force: true });
        } else {
          delete j.state.retry;
          j.state.state = "error";
          j.state.error = T(`le téléchargement a échoué : ${tr(errorText(e), "fr")}`, `the download failed: ${tr(errorText(e), "en")}`);
        }
        return;
      }
    }
  }

  /** Décompresse les archives (dossier temporaire, puis remplace le dossier final), puis efface les archives. */
  private async unpack(j: Job): Promise<void> {
    const targets = [...new Set(j.files.filter((f) => f.extract).map((f) => f.extract!))];
    for (const target of targets) {
      const tmp = `${target}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      try {
        for (const f of j.files.filter((x) => x.extract === target)) {
          if (j.abort.signal.aborted) throw new Error("annulé");
          await this.extract(f.dest, tmp);
        }
        rmSync(target, { recursive: true, force: true });
        renameSync(tmp, target);
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        // Les fichiers reçus sont vérifiés : réessayer ne changerait rien (outil absent, disque plein…).
        if (j.abort.signal.aborted) throw e;
        throw new Permanent(errorText(e));
      }
      for (const f of j.files.filter((x) => x.extract === target)) rmSync(f.dest, { force: true });
    }
  }

  /** Télécharge un fichier ; rend sa taille. `progress` reçoit les octets de ce fichier déjà sur le disque. */
  private async file(j: Job, f: Job["files"][number], progress: (got: number) => void): Promise<number> {
    const have = sizeOf(f.dest);
    if (have !== undefined && (f.size === undefined || have === f.size)) { progress(have); return have; }
    mkdirSync(dirname(f.dest), { recursive: true });
    const part = f.dest + PART;
    let start = sizeOf(part) ?? 0;
    if (f.size !== undefined && start > f.size) { rmSync(part, { force: true }); start = 0; }
    if (f.size === undefined || start < f.size) {
      let res = await this.fetch(f.url, { signal: j.abort.signal, ...(start ? { headers: { Range: `bytes=${start}-` } } : {}) });
      if (res.status === 416 && start) {
        // Le serveur refuse la reprise : on recommence ce fichier depuis le début.
        await res.body?.cancel().catch(() => {});
        rmSync(part, { force: true });
        start = 0;
        res = await this.fetch(f.url, { signal: j.abort.signal });
      }
      if (!res.ok || !res.body) {
        // 4xx (sauf 408 et 429) : l'adresse est fausse ou refusée, réessayer ne sert à rien.
        const Err = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? Permanent : TextError;
        throw new Err(T(`le serveur a répondu ${res.status}`, `the server answered ${res.status}`));
      }
      if (res.status !== 206) start = 0; // pas de reprise : le serveur renvoie tout
      const len = Number(res.headers.get("content-length"));
      if (f.size === undefined && Number.isFinite(len) && len > 0) {
        f.size = start + len;
        if (j.files.every((x) => x.size !== undefined)) j.state.total = j.files.reduce((n, x) => n + x.size!, 0);
      }
      const out = createWriteStream(part, { flags: start ? "a" : "w" });
      let got = start;
      progress(got);
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
          got += chunk.byteLength;
          progress(got);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (f.size !== undefined && got !== f.size) {
        throw new TextError(T(`fichier incomplet (${got} / ${f.size} octets)`, `incomplete file (${got} / ${f.size} bytes)`));
      }
    }
    if (f.sha256 && (await sha256Of(part)) !== f.sha256) {
      rmSync(part, { force: true });
      throw new TextError(T("le fichier reçu est abîmé (empreinte sha256 différente)", "the received file is damaged (sha256 mismatch)"));
    }
    if (existsSync(f.dest)) rmSync(f.dest, { force: true });
    renameSync(part, f.dest);
    return sizeOf(f.dest) ?? 0;
  }
}

/** Dossier des téléchargements d'une entrée de la config. */
export function downloadsDir(modelsDir: string, entry: string): string {
  return join(modelsDir, entry);
}
