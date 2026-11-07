// Lire la machine : puce graphique, type de mémoire, mémoire utilisable par les modèles, RAM, disque.
// Portable : NVIDIA (nvidia-smi), llama.cpp (--list-devices : CUDA, Vulkan, Metal, ROCm, SYCL), Apple (sysctl),
// registre des cartes (windows), /sys/class/drm (linux), indice de l'appli (identifiant PCI du fabricant).
// Chaque sonde est facultative : une sonde qui échoue est ignorée. Voir docs/spec/premier-lancement.md.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { T, type Text } from "./i18n.ts";

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "qualcomm" | "other";
export type MemoryKind = "dedicated" | "unified" | "none";
export type Backend = "cuda" | "vulkan" | "rocm" | "sycl" | "metal";

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** Puce dans le processeur (mémoire partagée avec la RAM). */
  integrated: boolean;
  /** Mémoire propre (VRAM, ou part réservée par le BIOS pour une puce intégrée), en octets. */
  totalBytes?: number;
  /** Mémoire libre maintenant (nvidia-smi, llama.cpp). */
  freeBytes?: number;
  /** Mémoire partagée prise dans la RAM (linux : GTT). */
  sharedBytes?: number;
  /** Version du pilote (NVIDIA : « 580.88 »), pour choisir la version de CUDA d'un programme. */
  driver?: string;
  backends: Backend[];
  /** Sondes qui l'ont vue. */
  sources: string[];
}

export interface MachineInfo {
  os: "windows" | "mac" | "linux" | "other";
  arch: string;
  cpu: string;
  cores: number;
  ramBytes: number;
  freeRamBytes: number;
  /** Place libre dans le dossier des modèles. */
  diskFreeBytes?: number;
  gpus: GpuInfo[];
  /** La puce graphique retenue pour les modèles. */
  gpu?: GpuInfo;
  memory: MemoryKind;
  /** Mémoire utilisable par les modèles sur la puce graphique (0 sans puce utile). */
  modelBytes: number;
  /** Mémoire pour les modèles qui tournent sur le processeur. */
  cpuBytes: number;
  backends: Backend[];
  /** Sondes qui ont répondu. */
  sources: string[];
}

/** Lance une commande, rend sa sortie (undefined : absente, en échec, trop longue). */
export type RunFn = (cmd: string, args: string[]) => Promise<string | undefined>;

export interface ProbeOptions {
  run?: RunFn;
  readFile?: (path: string) => string | undefined;
  listDir?: (path: string) => string[];
  platform?: NodeJS.Platform;
  arch?: string;
  totalmem?: number;
  freemem?: number;
  cpu?: { model: string; cores: number };
  /** Dossier des modèles (place libre). */
  diskDir?: string;
  statfs?: (dir: string) => { bavail: number; bsize: number } | undefined;
  /** llama-server trouvé : ses puces (--list-devices). */
  llamaExe?: string;
  /** Indice de l'appli : fabricants des puces vues par le navigateur (identifiant PCI). */
  hint?: { vendorId: number; name?: string }[];
}

export const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const VENDOR_IDS: Record<number, GpuVendor> = { 0x10de: "nvidia", 0x1002: "amd", 0x1022: "amd", 0x8086: "intel", 0x106b: "apple", 0x5143: "qualcomm", 0x4d4f4351: "qualcomm" };

export function vendorOf(name: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name)) return "nvidia";
  if (/\bamd\b|radeon|ati\b|instinct/i.test(name)) return "amd";
  if (/intel|\barc\b|iris|uhd graphics|hd graphics/i.test(name)) return "intel";
  if (/apple|\bm\d( pro| max| ultra)?\b/i.test(name)) return "apple";
  if (/qualcomm|adreno|snapdragon/i.test(name)) return "qualcomm";
  return "other";
}

/** Puce dans le processeur ? Lu dans le nom (« Radeon RX 7900 » : carte ; « Radeon 8060S », « Arc 140V » : intégrée). */
export function isIntegrated(vendor: GpuVendor, name: string): boolean {
  switch (vendor) {
    case "nvidia": return false;
    case "amd": return !/\bRX\s?\d|radeon\s+pro|radeon\s+vii|firepro|instinct/i.test(name);
    case "intel": return !/arc(\(tm\))?\s+[ab]\d{3}/i.test(name);
    case "apple": case "qualcomm": return true;
    default: return false;
  }
}

export function backendsOf(vendor: GpuVendor): Backend[] {
  switch (vendor) {
    case "nvidia": return ["cuda", "vulkan"];
    case "amd": return ["vulkan", "rocm"];
    case "intel": return ["vulkan", "sycl"];
    case "apple": return ["metal"];
    default: return ["vulkan"];
  }
}

const gpu = (name: string, source: string, extra: Partial<GpuInfo> = {}): GpuInfo => {
  const vendor = extra.vendor ?? vendorOf(name);
  return { name, vendor, integrated: isIntegrated(vendor, name), backends: backendsOf(vendor), sources: [source], ...extra };
};

// ------------------------------------------------------------------ lecteurs (purs, testés avec des sorties réelles)

/** `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits` (Mio). */
export function parseNvidiaSmi(out: string): GpuInfo[] {
  const list: GpuInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?),\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*$/.exec(line.trim());
    if (m) {
      list.push(gpu(m[1]!.trim(), "nvidia-smi", {
        vendor: "nvidia", integrated: false, totalBytes: Number(m[2]) * MIB, freeBytes: Number(m[3]) * MIB, ...(m[4] ? { driver: m[4] } : {}),
      }));
    }
  }
  return list;
}

/** Numéro principal d'un pilote (« 580.88 » → 580), 0 s'il est inconnu. */
export function driverMajor(g: GpuInfo | undefined): number {
  return Number(/^(\d+)/.exec(g?.driver ?? "")?.[1] ?? 0);
}

export interface LlamaDevice { backend: Backend; name: string; totalBytes: number; freeBytes: number }

/** `llama-server --list-devices` : « CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 22918 MiB free) ». */
export function parseLlamaDevices(out: string): LlamaDevice[] {
  const list: LlamaDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\d*\s*:\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/.exec(line);
    if (!m) continue;
    const p = m[1]!.toLowerCase();
    const backend: Backend | undefined = p === "cuda" ? "cuda" : p === "vulkan" ? "vulkan" : p === "mtl" || p === "metal" ? "metal"
      : p === "rocm" || p === "hip" ? "rocm" : p === "sycl" ? "sycl" : undefined;
    if (backend) list.push({ backend, name: m[2]!, totalBytes: Number(m[3]) * MIB, freeBytes: Number(m[4]) * MIB });
  }
  return list;
}

/**
 * Registre des cartes (windows) : `reg query <Class\{4d36e968…}> /s /v DriverDesc` et `… /v HardwareInformation.qwMemorySize`.
 * Chaque bloc commence par le chemin de la clé ; on relie nom et mémoire par ce chemin.
 */
export function parseWindowsRegistry(descOut: string, memOut: string | undefined): GpuInfo[] {
  const read = (out: string, value: string): Map<string, string> => {
    const map = new Map<string, string>();
    let key = "";
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (/^HKEY_/i.test(line)) { key = line.trim(); continue; }
      const m = new RegExp(`^\\s+${value.replace(/\./g, "\\.")}\\s+REG_\\w+\\s+(.+)$`, "i").exec(line);
      if (m && key) map.set(key, m[1]!.trim());
    }
    return map;
  };
  const names = read(descOut, "DriverDesc");
  const mems = memOut ? read(memOut, "HardwareInformation.qwMemorySize") : new Map<string, string>();
  const list: GpuInfo[] = [];
  for (const [key, name] of names) {
    if (/microsoft|remote display|virtual|parsec|citrix|vmware|hyper-v/i.test(name)) continue;
    const raw = mems.get(key);
    const bytes = raw ? Number(raw.startsWith("0x") ? BigInt(raw) : raw) : undefined;
    list.push(gpu(name, "registre", bytes && Number.isFinite(bytes) ? { totalBytes: bytes } : {}));
  }
  return list;
}

/** /sys/class/drm (linux) : AMD et Intel (NVIDIA passe par nvidia-smi). */
export function readLinuxDrm(listDir: (p: string) => string[], readFile: (p: string) => string | undefined): GpuInfo[] {
  const list: GpuInfo[] = [];
  const base = "/sys/class/drm";
  for (const card of listDir(base).filter((c) => /^card\d+$/.test(c)).sort()) {
    const dev = `${base}/${card}/device`;
    const vendor = VENDOR_IDS[Number(readFile(`${dev}/vendor`)?.trim())];
    if (!vendor || vendor === "nvidia") continue;
    const num = (f: string) => { const v = Number(readFile(`${dev}/${f}`)?.trim()); return Number.isFinite(v) && v > 0 ? v : undefined; };
    const vram = num("mem_info_vram_total");
    const gtt = num("mem_info_gtt_total");
    const label = readFile(`${dev}/product_name`)?.trim() || `${vendor === "amd" ? "AMD" : vendor === "intel" ? "Intel" : vendor} (${card})`;
    // AMD : peu de mémoire propre et une grande part partagée = puce intégrée. Intel sans mem_info : intégrée.
    const integrated = vendor === "amd" ? (vram ?? 0) < 8 * GIB && (gtt ?? 0) > (vram ?? 0) : vendor === "intel" ? vram === undefined || isIntegrated("intel", label) : true;
    list.push({ name: label, vendor, integrated, ...(vram ? { totalBytes: vram } : {}), ...(gtt ? { sharedBytes: gtt } : {}), backends: backendsOf(vendor), sources: ["drm"] });
  }
  return list;
}

// ------------------------------------------------------------------ budget

/** Mémoire utilisable par les modèles sur une puce. `ram` : RAM vue par le système. */
export function modelBudget(g: GpuInfo | undefined, ram: number): { memory: MemoryKind; bytes: number } {
  if (!g) return { memory: "none", bytes: 0 };
  const keepForSystem = Math.max(0, ram - 8 * GIB);
  if (g.vendor === "apple") {
    // Metal : environ 2/3 de la RAM jusqu'à 36 Go, 3/4 au-delà (ou ce que llama.cpp a lu), sans prendre les 8 Go du système.
    const share = g.freeBytes ?? (ram <= 36 * GIB ? ram * 2 / 3 : ram * 3 / 4);
    return { memory: "unified", bytes: Math.max(0, Math.min(share, keepForSystem)) };
  }
  if (g.integrated) {
    // Part réservée par le BIOS : réelle chez AMD (Ryzen AI). Chez Intel et Qualcomm, le registre annonce la part
    // partagée possible (souvent plus de la moitié de la RAM) : pas comptée deux fois.
    const own = g.vendor === "amd" ? g.totalBytes ?? 0 : 0;
    const shared = Math.min(g.sharedBytes ?? ram / 2, keepForSystem);
    const est = own + shared;
    const bytes = g.freeBytes !== undefined ? Math.min(Math.max(0, g.freeBytes - 0.5 * GIB), own + keepForSystem) : est;
    return { memory: "unified", bytes: Math.max(0, bytes) };
  }
  if (g.freeBytes !== undefined) return { memory: "dedicated", bytes: Math.max(0, g.freeBytes - 0.5 * GIB) };
  const total = g.totalBytes ?? 0;
  return { memory: "dedicated", bytes: Math.max(0, total - Math.max(GIB, total * 0.15)) };
}

/** Carte séparée la plus grande, sinon puce intégrée la plus grande. */
export function pickGpu(list: GpuInfo[]): GpuInfo | undefined {
  const size = (g: GpuInfo) => g.totalBytes ?? g.freeBytes ?? 0;
  const by = (a: GpuInfo, b: GpuInfo) => size(b) - size(a);
  return list.filter((g) => !g.integrated).sort(by)[0] ?? list.filter((g) => g.integrated).sort(by)[0];
}

const norm = (s: string) => s.toLowerCase().replace(/\((tm|r)\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const sameGpu = (a: string, b: string) => { const x = norm(a); const y = norm(b); return x === y || x.includes(y) || y.includes(x); };

/** Réunit les puces vues par plusieurs sondes (même nom = même puce ; la mémoire libre la plus précise gagne). */
export function mergeGpus(lists: GpuInfo[][], llama: LlamaDevice[] = []): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const list of lists) for (const g of list) {
    const cur = out.find((x) => x.vendor === g.vendor && sameGpu(x.name, g.name));
    if (!cur) { out.push({ ...g, sources: [...g.sources] }); continue; }
    cur.totalBytes ??= g.totalBytes;
    cur.freeBytes ??= g.freeBytes;
    cur.sharedBytes ??= g.sharedBytes;
    cur.driver ??= g.driver;
    for (const s of g.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
  }
  for (const d of llama) {
    const cur = out.find((x) => sameGpu(x.name, d.name));
    if (cur) {
      if (!cur.sources.includes("llama.cpp")) cur.sources.push("llama.cpp");
      if (cur.freeBytes === undefined) cur.freeBytes = d.freeBytes;
      if (cur.totalBytes === undefined && !cur.integrated) cur.totalBytes = d.totalBytes;
    } else if (!out.some((x) => x.sources.includes("llama.cpp") && sameGpu(x.name, d.name))) {
      // Une puce vue seulement par llama.cpp (CUDA et Vulkan peuvent montrer la même : une seule ligne).
      const g = gpu(d.name, "llama.cpp", { freeBytes: d.freeBytes });
      if (!g.integrated) g.totalBytes = d.totalBytes;
      out.push(g);
    }
  }
  return out;
}

// ------------------------------------------------------------------ sonde

export const defaultRun: RunFn = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * MIB }, (err, stdout) => resolve(err ? undefined : String(stdout)));
});

const defaultRead = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
const defaultList = (p: string) => { try { return readdirSync(p); } catch { return []; } };
const defaultStatfs = (dir: string) => { try { const s = statfsSync(dir); return { bavail: Number(s.bavail), bsize: Number(s.bsize) }; } catch { return undefined; } };

const WIN_GPU_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";

export async function probeMachine(opts: ProbeOptions = {}): Promise<MachineInfo> {
  const run = opts.run ?? defaultRun;
  const read = opts.readFile ?? defaultRead;
  const list = opts.listDir ?? defaultList;
  const platform = opts.platform ?? process.platform;
  const os: MachineInfo["os"] = platform === "win32" ? "windows" : platform === "darwin" ? "mac" : platform === "linux" ? "linux" : "other";
  const c = cpus();
  let cpu = opts.cpu?.model ?? c[0]?.model?.trim() ?? "";
  const cores = opts.cpu?.cores ?? c.length;
  let ram = opts.totalmem ?? totalmem();
  const sources: string[] = [];
  const lists: GpuInfo[][] = [];

  const [smi, llamaOut] = await Promise.all([
    run("nvidia-smi", ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]),
    opts.llamaExe ? run(opts.llamaExe, ["--list-devices"]) : Promise.resolve(undefined),
  ]);
  const nv = smi ? parseNvidiaSmi(smi) : [];
  if (nv.length) { lists.push(nv); sources.push("nvidia-smi"); }
  const llama = llamaOut ? parseLlamaDevices(llamaOut) : [];
  if (llama.length) sources.push("llama.cpp");

  if (os === "mac") {
    const [mem, brand] = await Promise.all([run("sysctl", ["-n", "hw.memsize"]), run("sysctl", ["-n", "machdep.cpu.brand_string"])]);
    if (mem && Number(mem.trim()) > 0) ram = Number(mem.trim());
    if (brand?.trim()) cpu = brand.trim();
    if (/^apple/i.test(cpu)) {
      lists.push([{ name: cpu, vendor: "apple", integrated: true, backends: ["metal"], sources: ["sysctl"] }]);
      sources.push("sysctl");
    }
  } else if (os === "windows") {
    const [desc, mem] = await Promise.all([
      run("reg", ["query", WIN_GPU_KEY, "/s", "/v", "DriverDesc"]),
      run("reg", ["query", WIN_GPU_KEY, "/s", "/v", "HardwareInformation.qwMemorySize"]),
    ]);
    const reg = desc ? parseWindowsRegistry(desc, mem) : [];
    if (reg.length) { lists.push(reg); sources.push("registre"); }
  } else if (os === "linux") {
    const drm = readLinuxDrm(list, read);
    if (drm.length) { lists.push(drm); sources.push("drm"); }
  }

  const gpus = mergeGpus(lists, llama);
  if (!gpus.length && opts.hint?.length) {
    // Rien de lu : le fabricant vu par l'appli, sans mémoire (estimée à partir de la RAM pour une puce intégrée).
    for (const h of opts.hint) {
      const vendor = VENDOR_IDS[h.vendorId];
      if (!vendor || gpus.some((x) => x.vendor === vendor)) continue;
      const name = h.name || ({ nvidia: "NVIDIA", amd: "AMD", intel: "Intel", apple: "Apple", qualcomm: "Qualcomm", other: "GPU" } as const)[vendor];
      gpus.push({ name, vendor, integrated: vendor === "nvidia" ? false : isIntegrated(vendor, name), backends: backendsOf(vendor), sources: ["appli"] });
    }
    if (gpus.length) sources.push("appli");
  }

  // Une carte séparée sans mémoire lue ne sert pas au budget (elle reste dans la liste, pour l'affichage).
  const chosen = pickGpu(gpus.filter((g) => g.integrated || g.totalBytes !== undefined || g.freeBytes !== undefined));
  const budget = modelBudget(chosen, ram);
  const disk = opts.diskDir ? (opts.statfs ?? defaultStatfs)(opts.diskDir) : undefined;
  return {
    os, arch: opts.arch ?? process.arch, cpu, cores, ramBytes: ram, freeRamBytes: opts.freemem ?? freemem(),
    ...(disk ? { diskFreeBytes: disk.bavail * disk.bsize } : {}),
    gpus, ...(chosen ? { gpu: chosen } : {}),
    memory: budget.memory, modelBytes: Math.round(budget.bytes), cpuBytes: Math.max(0, ram - 6 * GIB),
    backends: chosen?.backends ?? [], sources,
  };
}

// ------------------------------------------------------------------ texte

/** « 9,5 Go » / « 9.5 GB » (Gio, arrondi à 0,5). */
export function gbText(bytes: number): Text {
  const v = Math.round((bytes / GIB) * 2) / 2;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return T(`${s.replace(".", ",")} Go`, `${s} GB`);
}

/** Une ligne : la puce, le type de mémoire, la mémoire pour les modèles, la RAM. */
export function machineSummary(m: MachineInfo): Text {
  const fr: string[] = [];
  const en: string[] = [];
  const g = (b: number) => gbText(b) as { fr: string; en: string };
  if (m.gpu) {
    fr.push(m.gpu.name); en.push(m.gpu.name);
    if (m.memory === "unified") { fr.push("mémoire unifiée"); en.push("unified memory"); }
    else { fr.push(`carte séparée${m.gpu.totalBytes ? ` de ${g(m.gpu.totalBytes).fr}` : ""}`); en.push(`separate card${m.gpu.totalBytes ? ` with ${g(m.gpu.totalBytes).en}` : ""}`); }
    fr.push(`${g(m.modelBytes).fr} pour les modèles`); en.push(`${g(m.modelBytes).en} for models`);
  } else { fr.push("pas de puce graphique utile"); en.push("no usable graphics chip"); }
  fr.push(`RAM ${g(m.ramBytes).fr}`); en.push(`RAM ${g(m.ramBytes).en}`);
  return T(fr.join(" · "), en.join(" · "));
}
