// Programmes à télécharger (llama-server, audiocpp_server…) : une aide pour les plugins, comme modelLibrary.
// Le plugin donne les archives figées d'une version (une par système, processeur et moteur) ; l'aide choisit celle
// qui va à la machine (ctx.machine), la télécharge et la décompresse (ctx.downloads), et dit où est le programme.
// Elle se montre dans la même bibliothèque que les modèles du plugin. Voir docs/spec/premier-lancement.md.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { writeJsonAtomic } from "./util/files.ts";
import type { ChildProcess } from "node:child_process";
import type { Context } from "./plugin/context.ts";
import type { ItemInfo, OpResult } from "./catalog.ts";
import type { DownloadFile } from "./downloads.ts";
import { formatBytes } from "./model-library.ts";
import { driverMajor, type Backend, type MachineInfo } from "./machine.ts";
import { T, tr, type Text } from "./i18n.ts";

export interface ProgramBuild {
  /** Unique (lettres, chiffres, « - . »), ex. « b12177-win-cuda13-x64 ». Nom du dossier du programme. */
  id: string;
  /** Moteur, en mots simples (« CUDA 13 (cartes NVIDIA récentes) »). */
  label: Text;
  os: "windows" | "mac" | "linux";
  arch: "x64" | "arm64";
  backend: Backend | "cpu";
  /** cuda : pilote NVIDIA minimal (numéro principal, ex. 580). */
  minDriver?: number;
  /** Archives (.zip, .tar.gz), décompressées ensemble dans le dossier du programme. */
  files: Omit<DownloadFile, "path" | "extract">[];
}

export interface ProgramOptions {
  /** Id du fournisseur (ex. "llm-local-program"). */
  id: string;
  section: string;
  /** Services des modèles de ce programme : la fenêtre le montre dans la même bibliothèque. */
  offers: string | string[];
  /** Nom du programme (« llama.cpp »). */
  label: Text;
  description?: Text;
  order?: number;
  /** Nom de l'exécutable, sans extension (« llama-server »). */
  program: string;
  version: string;
  builds: ProgramBuild[];
  licence?: { name: string; url?: string };
  /** Arguments pour vérifier que le programme se lance (défaut : « --version »). */
  probeArgs?: string[];
  /**
   * Le programme a changé : le plugin relit son chemin. `why` : « upgrade » (version pour la puce graphique),
   * « failover » (la précédente ne marchait pas), « repair » (réparé) : relancer les modèles en marche ;
   * « update » (nouvelle version), « installed », « removed » : au prochain lancement suffit.
   */
  changed?(why: ProgramChange): void;
}

export type ProgramChange = "installed" | "update" | "upgrade" | "failover" | "repair" | "removed";

/** Le programme a changé pour une raison qui demande de relancer tout de suite les modèles qui tournent. */
export const restartsModels = (why: ProgramChange): boolean => why === "upgrade" || why === "failover" || why === "repair";

/** Message d'une panne de démarrage pendant que Floppy télécharge une autre version du programme. */
export function failoverText(label: Text, next: ProgramBuild): Text {
  return T(`${tr(label, "fr")} ne marche pas sur cette machine dans cette version : Floppy télécharge la version ${tr(next.label, "fr")}, puis relance tout seul.`,
    `${tr(label, "en")} does not work on this computer in this version: Floppy is downloading the ${tr(next.label, "en")} version, then restarts on its own.`);
}

export interface ProgramLibrary {
  /** Chemin du programme installé par Floppy, s'il est là. */
  path(): string | undefined;
  /** Archive installée par Floppy (son moteur), si elle est là. */
  installed(): ProgramBuild | undefined;
  refresh(): void;
  /**
   * Des modèles demandent la puce graphique : si la version installée est « processeur » et que la machine a mieux,
   * Floppy télécharge la meilleure (en fond ; la version processeur sert en attendant). Rend celle qui se télécharge.
   */
  want(device: "gpu"): Promise<ProgramBuild | undefined>;
  /**
   * Le programme n'a pas démarré. Floppy vérifie qu'il se lance ; sinon il note cette version comme cassée sur la
   * machine et télécharge la suivante (CUDA → Vulkan → processeur). Rend la nouvelle, undefined si rien à faire.
   */
  failed(reason: string): Promise<ProgramBuild | undefined>;
}

const archOf = (a: string): "x64" | "arm64" | undefined => (a === "x64" ? "x64" : a === "arm64" ? "arm64" : undefined);
const osOf = (o: MachineInfo["os"]): ProgramBuild["os"] | undefined => (o === "other" ? undefined : o);

/**
 * L'archive qui va à la machine. NVIDIA : CUDA si le pilote le permet (la plus récente), sinon Vulkan.
 * Apple : Metal. AMD, Intel, Qualcomm : Vulkan. Sans puce : processeur. Repli : processeur.
 */
export function pickBuild(builds: ProgramBuild[], m: MachineInfo): ProgramBuild | undefined {
  const os = osOf(m.os);
  const arch = archOf(m.arch);
  const mine = builds.filter((b) => b.os === os && b.arch === arch);
  const by = (backend: ProgramBuild["backend"]) => mine.filter((b) => b.backend === backend);
  const vendor = m.memory === "none" ? undefined : m.gpu?.vendor;
  const order: ProgramBuild["backend"][] = vendor === "nvidia" ? ["cuda", "vulkan", "cpu"]
    : vendor === "apple" ? ["metal", "cpu"]
    : vendor ? ["vulkan", "cpu"] : ["cpu"];
  const driver = driverMajor(m.gpu);
  for (const backend of order) {
    const ok = by(backend).filter((b) => !b.minDriver || driver >= b.minDriver).sort((a, b) => (b.minDriver ?? 0) - (a.minDriver ?? 0));
    if (ok[0]) return ok[0];
  }
  return undefined;
}

/** Cherche l'exécutable dans un dossier décompressé (il peut être dans un sous-dossier). */
export function findProgram(dir: string, program: string, windows = process.platform === "win32"): string | undefined {
  const name = windows ? `${program}.exe` : program;
  const walk = (d: string, depth: number): string | undefined => {
    let names: string[];
    try { names = readdirSync(d); } catch { return undefined; }
    if (names.includes(name)) return join(d, name);
    if (depth >= 3) return undefined;
    for (const n of names) {
      const p = join(d, n);
      try { if (statSync(p).isDirectory()) { const f = walk(p, depth + 1); if (f) return f; } } catch { /* illisible */ }
    }
    return undefined;
  };
  return walk(dir, 0);
}

/**
 * Codes de sortie d'un programme qui n'a pas pu se charger : bibliothèque absente (windows 0xC0000135, linux 127),
 * archive pour une autre machine (0xC000007B), instruction que le processeur ne connaît pas (0xC000001D).
 * Un autre code (ex. argument inconnu) veut dire que le programme a tourné : il n'est pas cassé.
 */
const LOAD_FAILED = new Set([0xc0000135, 0xc000007b, 0xc000001d, 127]);

/** Le programme se charge-t-il sur cette machine ? `spawn` le lance avec les arguments donnés. */
export function programRuns(spawn: (args: string[]) => ChildProcess, args: string[], timeoutMs = 20_000): Promise<boolean> {
  return new Promise((ok) => {
    let done = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const end = (v: boolean) => { if (!done) { done = true; if (t) clearTimeout(t); ok(v); } };
    let child: ChildProcess;
    try { child = spawn(args); } catch { return ok(false); }
    t = setTimeout(() => { child.kill(); end(true); }, timeoutMs); // encore en vie : il a démarré
    child.on("exit", (code, signal) => end(!(signal === "SIGILL" || signal === "SIGBUS" || (code !== null && LOAD_FAILED.has(code >>> 0)))));
    child.on("error", () => end(false));
  });
}

/** Ce qui était installé par Floppy (programs/current.json). */
interface Current { version?: string; build: string; exe: string }

/** Rangement : programs/<version>/<archive>/ ; le fichier current.json dit lequel sert. */
export function programLibrary(ctx: Context, opts: ProgramOptions): ProgramLibrary {
  const base = () => join(ctx.downloads.dir, "programs");
  const currentFile = () => join(base(), "current.json");
  const brokenFile = () => join(base(), "broken.json");
  const readJson = <X>(f: string): X | undefined => { try { return JSON.parse(readFileSync(f, "utf8")) as X; } catch { return undefined; } };
  const readCurrent = () => readJson<Current>(currentFile());
  /** Archives qui n'ont pas marché sur cette machine (pilote trop vieux, bibliothèque absente…) : plus choisies. */
  const broken = (): Set<string> => new Set(readJson<string[]>(brokenFile()) ?? []);
  const setBroken = (ids: Set<string>) => { mkdirSync(base(), { recursive: true }); writeJsonAtomic(brokenFile(), [...ids]); };
  const key = (b: ProgramBuild) => `program/${opts.version}/${b.id}`;
  const dirOf = (b: ProgramBuild) => join(base(), opts.version, b.id);
  const installed = (): ProgramBuild | undefined => {
    const c = readCurrent();
    const b = c ? opts.builds.find((x) => x.id === c.build) : undefined;
    return b && c && existsSync(join(base(), c.exe)) ? b : undefined;
  };
  const path = (): string | undefined => {
    const c = readCurrent();
    return c && installed() ? join(base(), c.exe) : undefined;
  };
  /** La meilleure archive pour la machine, sans celles qui n'y ont pas marché. */
  const pick = async () => pickBuild(opts.builds.filter((b) => !broken().has(b.id)), await ctx.machine());
  const size = (b: ProgramBuild) => b.files.reduce((n, f) => n + (f.size ?? 0), 0);
  const loading = (b: ProgramBuild) => { const d = ctx.downloads.get(key(b)); return d?.state === "queued" || d?.state === "running"; };
  /** Pourquoi chaque téléchargement en cours a été lancé (dit au plugin à la fin). */
  const why = new Map<string, ProgramChange>();

  function start(b: ProgramBuild, reason: ProgramChange): void {
    if (loading(b)) return;
    why.set(b.id, reason);
    ctx.log("info", `programme ${tr(opts.label, "fr")} : téléchargement de ${b.id} (${reason})`);
    ctx.downloads.start({
      key: key(b), label: T(`${tr(opts.label, "fr")} (${tr(b.label, "fr")})`, `${tr(opts.label, "en")} (${tr(b.label, "en")})`),
      files: b.files.map((f, i) => ({ ...f, path: `programs/${opts.version}/${b.id}-${i}${f.url.endsWith(".zip") ? ".zip" : ".tar.gz"}`, extract: `programs/${opts.version}/${b.id}` })),
    });
  }

  /** Efface les dossiers qui ne servent plus (un programme en marche bloque le sien : il partira la fois suivante). */
  function cleanup(): void {
    const c = readCurrent();
    const keep = c ? join(base(), c.exe) : "";
    let names: string[];
    try { names = readdirSync(base()); } catch { return; }
    for (const v of names) {
      const p = join(base(), v);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      // Dossier d'une autre version (ou d'avant les versions) : il part, sauf celui du programme en service.
      const inner = v === opts.version ? readdirSync(p).map((n) => join(p, n)) : [p];
      for (const d of inner) {
        if (keep.startsWith(d + sep) || opts.builds.some((b) => loading(b) && d === dirOf(b))) continue;
        try { if (statSync(d).isDirectory()) rmSync(d, { recursive: true, force: true }); } catch { /* en marche */ }
      }
    }
  }

  /** Après le téléchargement : trouve le programme, le rend exécutable, le note comme installé, efface les anciens. */
  function finish(b: ProgramBuild): void {
    const exe = findProgram(dirOf(b), opts.program);
    if (!exe) {
      ctx.log("error", `programme : ${opts.program} introuvable dans l'archive ${b.id}`);
      return;
    }
    if (process.platform !== "win32") { try { chmodSync(exe, 0o755); } catch { /* déjà exécutable */ } }
    writeJsonAtomic(currentFile(), { version: opts.version, build: b.id, exe: relative(base(), exe) } satisfies Current);
    cleanup();
    const reason = why.get(b.id) ?? "installed";
    why.delete(b.id);
    opts.changed?.(reason);
  }

  ctx.downloads.onChange((s) => {
    const b = opts.builds.find((x) => key(x) === s.key);
    if (!b) return;
    if (s.state === "done") finish(b);
    ctx.items.changed();
  });

  /**
   * Au démarrage : réparer et mettre à jour ce que Floppy a installé (rien d'installé par Floppy : rien à faire).
   * - Une autre version est figée dans Floppy : la même archive (même moteur) dans la nouvelle version, en fond ;
   *   l'ancienne sert jusqu'à la fin.
   * - Le programme a disparu ou est abîmé : il est téléchargé de nouveau.
   */
  async function maintain(): Promise<void> {
    const c = readCurrent();
    if (!c) return;
    cleanup();
    const same = opts.builds.find((x) => x.id === c.build && !broken().has(x.id));
    if (c.version !== opts.version) {
      const target = same ?? await pick();
      if (target) start(target, "update");
      return;
    }
    if (!installed()) {
      const target = same ?? await pick();
      if (target) start(target, "repair");
    }
  }
  void maintain().catch((e) => ctx.log("warn", `programme ${tr(opts.label, "fr")} : entretien impossible`, { err: String(e) }));

  /** Le programme se lance-t-il ? (`--version` : il charge ses bibliothèques, puis s'arrête) */
  function selfTest(exe: string): Promise<boolean> {
    return programRuns((a) => ctx.spawn(exe, a, { stdio: "ignore", cwd: dirname(exe) }), opts.probeArgs ?? ["--version"]);
  }

  async function item(b: ProgramBuild, isChosen: boolean): Promise<ItemInfo> {
    const d = ctx.downloads.get(key(b));
    const cur = installed();
    const c = readCurrent();
    const total = size(b);
    const licence = opts.licence?.url ? [{ id: "licence", label: T("Licence", "Licence") }] : [];
    const base: ItemInfo = {
      id: b.id, enabled: true, service: "program", size: total, backend: b.backend,
      label: T(`${tr(opts.label, "fr")} ${opts.version} · ${tr(b.label, "fr")}`, `${tr(opts.label, "en")} ${opts.version} · ${tr(b.label, "en")}`),
      detail: broken().has(b.id) ? T("N'a pas marché sur cette machine : Floppy en a pris une autre.", "Did not work on this computer: Floppy took another one.")
        : isChosen ? T("Le programme qui fait tourner ces modèles, choisi pour ta machine.", "The program that runs these models, picked for your computer.")
        : T("Le programme qui fait tourner ces modèles.", "The program that runs these models."),
      tags: [formatBytes(total), ...(opts.licence ? [opts.licence.name] : []), T("programme", "program")],
    };
    if (d && (d.state === "queued" || d.state === "running")) {
      const progress = d.total ? Math.min(1, d.received / d.total) : 0;
      const pct = Math.floor(progress * 100);
      const text = d.state === "queued" ? T("En attente…", "Waiting…")
        : d.retry ? T(`${pct} % · nouvel essai ${d.retry}`, `${pct}% · retry ${d.retry}`) : T(`${pct} %`, `${pct}%`);
      return { ...base, status: "loading", statusText: text, progress, actions: [{ id: "cancel", label: T("Annuler", "Cancel") }] };
    }
    if (cur?.id === b.id) {
      const old = c?.version !== opts.version;
      return {
        ...base, status: "ok", statusText: old ? T(`Installé (${c?.version ?? "ancienne version"})`, `Installed (${c?.version ?? "older version"})`) : T("Installé", "Installed"),
        actions: [...(old ? [{ id: "download", label: T("Mettre à jour", "Update") }] : []), { id: "remove", label: T("Supprimer", "Delete") }, ...licence],
      };
    }
    if (d?.state === "error") return { ...base, status: "error", statusText: d.error ?? T("Échec", "Failed"), actions: [{ id: "download", label: T("Réessayer", "Retry") }, ...licence] };
    return { ...base, actions: [{ id: "download", label: cur ? T("Mettre à jour", "Update") : T("Télécharger", "Download") }, ...licence] };
  }

  ctx.items.declare({
    id: opts.id, section: opts.section, layout: "library", offers: opts.offers, label: opts.label,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.order !== undefined ? { order: opts.order } : {}),
    async list() {
      const best = await pick();
      const cur = installed();
      // Aussi la version « processeur » : bien plus petite, elle suffit aux modèles qui tournent sur le processeur.
      const m = await ctx.machine();
      const cpu = best && best.backend !== "cpu" ? pickBuild(opts.builds, { ...m, memory: "none", backends: [] }) : undefined;
      const shown = [...new Map([cur, best, cpu].filter((x): x is ProgramBuild => !!x).map((b) => [b.id, b])).values()];
      return Promise.all(shown.map((b) => item(b, b.id === best?.id)));
    },
    async action(id, action): Promise<OpResult> {
      const b = opts.builds.find((x) => x.id === id);
      if (!b) return { ok: false, text: T("Version inconnue.", "Unknown version.") };
      switch (action) {
        case "download": {
          // Choisie à la main : on lui redonne sa chance, même si elle n'avait pas marché.
          const bad = broken();
          if (bad.delete(b.id)) setBroken(bad);
          start(b, installed() ? "update" : "installed");
          return { ok: true, text: T(`Téléchargement lancé : ${tr(opts.label, "fr")}`, `Download started: ${tr(opts.label, "en")}`) };
        }
        case "cancel":
          ctx.downloads.cancel(key(b));
          return { ok: true, text: T("Téléchargement annulé.", "Download cancelled.") };
        case "remove": {
          if (installed()?.id === b.id) rmSync(currentFile(), { force: true });
          try { rmSync(dirOf(b), { recursive: true, force: true }); } catch { /* en marche : le dossier reste, il n'est plus utilisé */ }
          opts.changed?.("removed");
          return { ok: true, text: T(`${tr(opts.label, "fr")} est supprimé.`, `${tr(opts.label, "en")} is deleted.`) };
        }
        case "licence":
          return opts.licence?.url ? { ok: true, text: T("Licence ouverte.", "Licence opened."), open: opts.licence.url } : { ok: false, text: T("Pas de lien de licence.", "No licence link.") };
        default:
          return { ok: false, text: T("Action inconnue.", "Unknown action.") };
      }
    },
  });

  return {
    path, installed, refresh: () => ctx.items.changed(),
    async want(device) {
      if (device !== "gpu") return undefined;
      const cur = installed();
      if (cur && cur.backend !== "cpu") return undefined;
      const best = await pick();
      if (!best || best.backend === "cpu") return undefined;
      start(best, "upgrade");
      return best;
    },
    async failed(reason) {
      const cur = installed();
      const exe = path();
      if (!cur || !exe) return undefined;
      if (await selfTest(exe)) return undefined; // il se lance : la panne vient d'ailleurs (modèle, réglage)
      const bad = broken();
      bad.add(cur.id);
      setBroken(bad);
      const next = await pick();
      ctx.log("warn", `programme ${tr(opts.label, "fr")} : ${cur.id} ne marche pas sur cette machine (${reason})${next ? ` ; repli sur ${next.id}` : ""}`);
      if (next) start(next, "failover");
      return next;
    },
  };
}
