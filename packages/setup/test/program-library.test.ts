import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Kernel, definePlugin, type MachineInfo } from "@floppy/core";
import { programLibrary, pickBuild, findProgram, programRuns, type ProgramBuild, type ProgramLibrary, type ProgramChange } from "../src/index.ts";

const GIB = 1024 ** 3;
const f = (name: string) => ({ url: `https://github.com/x/releases/download/v1/${name}`, size: 10, sha256: "0".repeat(64) });
const BUILDS: ProgramBuild[] = [
  { id: "win-cuda13", label: "CUDA 13", os: "windows", arch: "x64", backend: "cuda", minDriver: 580, files: [f("a.zip"), f("cudart.zip")] },
  { id: "win-cuda12", label: "CUDA 12", os: "windows", arch: "x64", backend: "cuda", minDriver: 552, files: [f("b.zip")] },
  { id: "win-vulkan", label: "Vulkan", os: "windows", arch: "x64", backend: "vulkan", files: [f("c.zip")] },
  { id: "win-cpu", label: "CPU", os: "windows", arch: "x64", backend: "cpu", files: [f("d.zip")] },
  { id: "mac-arm64", label: "Metal", os: "mac", arch: "arm64", backend: "metal", files: [f("e.tar.gz")] },
  { id: "linux-vulkan", label: "Vulkan", os: "linux", arch: "x64", backend: "vulkan", files: [f("g.tar.gz")] },
  { id: "linux-cpu", label: "CPU", os: "linux", arch: "x64", backend: "cpu", files: [f("h.tar.gz")] },
];

const machine = (m: Partial<MachineInfo> & { vendor?: "nvidia" | "amd" | "intel" | "apple"; driver?: string }): MachineInfo => ({
  os: "windows", arch: "x64", cpu: "CPU", cores: 8, ramBytes: 32 * GIB, freeRamBytes: 16 * GIB, gpus: [],
  memory: m.vendor ? "dedicated" : "none", modelBytes: m.vendor ? 8 * GIB : 0, cpuBytes: 26 * GIB, backends: [], sources: [],
  ...(m.vendor ? { gpu: { name: "GPU", vendor: m.vendor, integrated: false, backends: [], sources: [], ...(m.driver ? { driver: m.driver } : {}) } } : {}),
  ...m,
});

describe("choix de l'archive selon la machine", () => {
  it("NVIDIA : CUDA le plus récent permis par le pilote, sinon Vulkan", () => {
    expect(pickBuild(BUILDS, machine({ vendor: "nvidia", driver: "596.72" }))?.id).toBe("win-cuda13");
    expect(pickBuild(BUILDS, machine({ vendor: "nvidia", driver: "560.94" }))?.id).toBe("win-cuda12");
    expect(pickBuild(BUILDS, machine({ vendor: "nvidia", driver: "537.13" }))?.id).toBe("win-vulkan");
    expect(pickBuild(BUILDS, machine({ vendor: "nvidia" }))?.id).toBe("win-vulkan"); // pilote inconnu
  });

  it("AMD et Intel : Vulkan ; Mac Apple : Metal ; sans puce : processeur", () => {
    expect(pickBuild(BUILDS, machine({ vendor: "amd" }))?.id).toBe("win-vulkan");
    expect(pickBuild(BUILDS, machine({ vendor: "apple", os: "mac", arch: "arm64", memory: "unified" }))?.id).toBe("mac-arm64");
    expect(pickBuild(BUILDS, machine({}))?.id).toBe("win-cpu");
    expect(pickBuild(BUILDS, machine({ vendor: "nvidia", driver: "596", os: "linux" }))?.id).toBe("linux-vulkan");
  });

  it("aucune archive pour ce système : rien", () => {
    expect(pickBuild(BUILDS, machine({ arch: "arm64" }))).toBeUndefined();
  });

  it("trouve le programme dans un sous-dossier de l'archive", () => {
    const d = mkdtempSync(join(tmpdir(), "prog-"));
    mkdirSync(join(d, "llama-b1", "bin"), { recursive: true });
    writeFileSync(join(d, "llama-b1", "bin", "llama-server.exe"), "");
    expect(findProgram(d, "llama-server", true)).toBe(join(d, "llama-b1", "bin", "llama-server.exe"));
    expect(findProgram(d, "llama-server", false)).toBeUndefined();
  });
});

describe("programLibrary dans le noyau", () => {
  it("montre l'archive choisie, la télécharge, la décompresse, puis donne le chemin du programme", async () => {
    let lib!: ProgramLibrary;
    const changed = vi.fn();
    const plugin = definePlugin({
      manifest: { id: "runner", version: "0", licence: "MIT", permissions: { net: ["github.com"] } },
      apply(ctx) {
        lib = programLibrary(ctx, { id: "runner-program", section: "brain", offers: "llm", label: "llama.cpp", program: "llama-server", version: "v1", builds: BUILDS, changed });
      },
    });
    const extracted: string[] = [];
    const k = new Kernel({
      logger: () => {}, plugins: [plugin], home: mkdtempSync(join(tmpdir(), "prog-home-")),
      machine: { platform: "win32", arch: "x64", run: async (cmd) => (cmd === "nvidia-smi" ? "NVIDIA RTX, 12000, 11000, 596.10\n" : undefined), readFile: () => undefined, listDir: () => [] },
      downloads: {
        fetch: (async () => new Response("0123456789", { headers: { "content-length": "10" } })) as unknown as typeof fetch,
        // Fausse décompression : chaque archive dépose un fichier ; la première dépose le programme dans un sous-dossier.
        extract: async (archive, dir) => {
          extracted.push(archive.replace(/^.*[\\/]/, ""));
          mkdirSync(join(dir, "bin"), { recursive: true });
          writeFileSync(join(dir, "bin", extracted.length === 1 ? (process.platform === "win32" ? "llama-server.exe" : "llama-server") : "cudart.dll"), "");
        },
      },
    });
    try {
      await k.applyConfig({ plugins: [{ id: "llm", plugin: "runner" }] });
      // Fausse empreinte : on vérifie seulement le chemin ; on enlève sha256 pour ce test.
      for (const b of BUILDS) for (const x of b.files) delete (x as { sha256?: string }).sha256;
      const snap = async () => (await k.items.snapshot()).find((p) => p.id === "runner-program")!;
      const first = await snap();
      expect(first.layout).toBe("library");
      // La version choisie, et la version « processeur » (plus petite, pour les modèles du processeur).
      expect(first.items.map((i) => [i.id, i.service, i.backend, i.size])).toEqual([["win-cuda13", "program", "cuda", 20], ["win-cpu", "program", "cpu", 10]]);
      expect(lib.path()).toBeUndefined();
      expect((await k.items.run({ op: "action", provider: "runner-program", id: "win-cuda13", action: "download" }, "ui")).ok).toBe(true);
      await vi.waitFor(async () => expect((await snap()).items.find((i) => i.id === "win-cuda13")?.status).toBe("ok"));
      expect(extracted).toEqual(["win-cuda13-0.zip", "win-cuda13-1.zip"]);
      expect(lib.path()).toMatch(/programs[\\/]v1[\\/]win-cuda13[\\/]bin[\\/]llama-server/);
      expect(lib.installed()?.backend).toBe("cuda");
      expect(changed).toHaveBeenCalledWith("installed");
      // Supprimer : plus de programme.
      await k.items.run({ op: "action", provider: "runner-program", id: "win-cuda13", action: "remove" }, "ui");
      expect(lib.path()).toBeUndefined();
    } finally { await k.stopAll(); }
  });
});

describe("le programme se charge-t-il ?", () => {
  /** Faux programme : sort avec ce code (ou ce signal), ou ne se lance pas. */
  const fake = (code: number | null, signal?: string, error?: boolean) => () => {
    const c = new EventEmitter() as unknown as ChildProcess;
    (c as unknown as { kill: () => void }).kill = () => {};
    setTimeout(() => (error ? c.emit("error", new Error("ENOENT")) : c.emit("exit", code, signal ?? null)), 1);
    return c;
  };
  it("bibliothèque absente, autre machine, instruction inconnue : cassé", async () => {
    expect(await programRuns(fake(0xc0000135), [])).toBe(false);
    expect(await programRuns(fake(-1073741515), [])).toBe(false); // même code, en négatif
    expect(await programRuns(fake(127), [])).toBe(false);
    expect(await programRuns(fake(null, "SIGILL"), [])).toBe(false);
    expect(await programRuns(fake(0, undefined, true), [])).toBe(false);
  });
  it("il tourne (même s'il refuse l'argument) : pas cassé", async () => {
    expect(await programRuns(fake(0), [])).toBe(true);
    expect(await programRuns(fake(1), [])).toBe(true);
  });
});

describe("réparer, mettre à jour, monter en version, se replier", () => {
  const exeName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  /** Un noyau avec le plugin ; chaque archive téléchargée dépose le programme. `home` : pour retrouver un état d'avant. */
  async function setup(opts: { home?: string; version?: string } = {}) {
    let lib!: ProgramLibrary;
    const changes: ProgramChange[] = [];
    const builds = BUILDS.map((b) => ({ ...b, files: b.files.map((x) => ({ url: x.url, size: 10 })) }));
    const plugin = definePlugin({
      manifest: { id: "runner", version: "0", licence: "MIT", permissions: { net: ["github.com"], exec: ["llama-server"] } },
      apply(ctx) {
        lib = programLibrary(ctx, { id: "runner-program", section: "brain", offers: "llm", label: "llama.cpp", program: "llama-server", version: opts.version ?? "v2", builds, changed: (w) => changes.push(w) });
      },
    });
    const home = opts.home ?? mkdtempSync(join(tmpdir(), "prog-home-"));
    const fetched: string[] = [];
    const k = new Kernel({
      logger: () => {}, plugins: [plugin], home,
      machine: { platform: "win32", arch: "x64", run: async (cmd) => (cmd === "nvidia-smi" ? "NVIDIA RTX, 12000, 11000, 596.10\n" : undefined), readFile: () => undefined, listDir: () => [] },
      downloads: {
        retryMs: [],
        fetch: (async (u: string) => { fetched.push(String(u)); return new Response("0123456789", { headers: { "content-length": "10" } }); }) as unknown as typeof fetch,
        extract: async (_a, dir) => { mkdirSync(join(dir, "bin"), { recursive: true }); writeFileSync(join(dir, "bin", exeName), ""); },
      },
    });
    await k.applyConfig({ plugins: [{ id: "llm", plugin: "runner" }] });
    return { k, lib: () => lib, changes, home, fetched };
  }
  const run = (k: Kernel, id: string, action: string) => k.items.run({ op: "action", provider: "runner-program", id, action }, "ui");
  /** Dossier « programs » à partir du chemin du programme (programs/<version>/<archive>/bin/llama-server). */
  const programsDir = (exe: string) => dirname(dirname(dirname(dirname(exe))));

  it("version « processeur » installée, des modèles veulent la puce graphique : la bonne version se télécharge, puis remplace", async () => {
    const t = await setup();
    try {
      await run(t.k, "win-cpu", "download");
      await vi.waitFor(() => expect(t.lib().installed()?.id).toBe("win-cpu"));
      expect((await t.lib().want("gpu"))?.id).toBe("win-cuda13");
      await vi.waitFor(() => expect(t.lib().installed()?.id).toBe("win-cuda13"));
      expect(t.changes).toEqual(["installed", "upgrade"]);
      expect(await t.lib().want("gpu")).toBeUndefined(); // déjà la bonne
      expect(existsSync(join(programsDir(t.lib().path()!), "v2", "win-cpu"))).toBe(false); // l'ancienne est effacée
    } finally { await t.k.stopAll(); }
  });

  it("mise à jour : une autre version figée dans Floppy ; la même archive se télécharge en fond, l'ancienne sert en attendant", async () => {
    const a = await setup({ version: "v1" });
    await run(a.k, "win-cpu", "download");
    await vi.waitFor(() => expect(a.lib().installed()?.id).toBe("win-cpu"));
    await a.k.stopAll();
    // Floppy mis à jour : il fige v2. Au démarrage : la version processeur en v2 (c'était le choix), pas la meilleure.
    const b = await setup({ home: a.home, version: "v2" });
    try {
      await vi.waitFor(() => expect(b.changes).toEqual(["update"]));
      expect(b.lib().path()).toMatch(/programs[\\/]v2[\\/]win-cpu[\\/]/);
      expect(b.fetched).toHaveLength(1);
      expect(existsSync(join(programsDir(b.lib().path()!), "v1"))).toBe(false);
    } finally { await b.k.stopAll(); }
  });

  it("réparation : le programme a disparu ; il se télécharge de nouveau au démarrage", async () => {
    const t = await setup();
    try {
      await run(t.k, "win-cuda13", "download");
      await vi.waitFor(() => expect(t.lib().installed()?.id).toBe("win-cuda13"));
      const exe = t.lib().path()!;
      rmSync(exe);
      await t.k.restart("llm"); // comme un redémarrage de Floppy
      await vi.waitFor(() => expect(t.changes).toEqual(["installed", "repair"]));
      expect(existsSync(exe)).toBe(true);
    } finally { await t.k.stopAll(); }
  });

  it("repli : le programme ne se charge pas ; il est noté cassé et la version suivante se télécharge", async () => {
    const t = await setup();
    try {
      await run(t.k, "win-cuda13", "download");
      await vi.waitFor(() => expect(t.lib().installed()?.id).toBe("win-cuda13"));
      // Le faux programme est un fichier vide : il ne se lance pas.
      expect((await t.lib().failed("plantage"))?.id).toBe("win-cuda12");
      await vi.waitFor(() => expect(t.lib().installed()?.id).toBe("win-cuda12"));
      expect(t.changes.at(-1)).toBe("failover");
      // CUDA 13 n'est plus proposée comme meilleure : CUDA 12 l'est.
      const items = (await t.k.items.snapshot()).find((p) => p.id === "runner-program")!.items;
      expect(items.map((i) => i.id)).toEqual(["win-cuda12", "win-cpu"]);
    } finally { await t.k.stopAll(); }
  });
});
