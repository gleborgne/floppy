import { describe, it, expect } from "vitest";
import {
  GIB, gbText, machineSummary, modelBudget, parseLlamaDevices, parseNvidiaSmi, parseWindowsRegistry, probeMachine, readLinuxDrm,
  isIntegrated, driverMajor, type RunFn,
} from "../src/machine.ts";
import { tr } from "../src/i18n.ts";

const KEY = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
const regDesc = (...names: string[]) => names.map((n, i) => `\r\n${KEY}\\000${i}\r\n    DriverDesc    REG_SZ    ${n}\r\n`).join("") + "\r\nEnd of search: 2 match(es) found.\r\n";
const regMem = (...sizes: (string | undefined)[]) => sizes.map((s, i) => (s ? `\r\n${KEY}\\000${i}\r\n    HardwareInformation.qwMemorySize    REG_QWORD    ${s}\r\n` : "")).join("");

/** Commandes simulées : nom (et premier argument) → sortie. */
const fake = (outs: Record<string, string>): RunFn => async (cmd, args) => {
  const k = `${cmd} ${args.join(" ")}`;
  for (const [pat, out] of Object.entries(outs)) if (k.includes(pat)) return out;
  return undefined;
};
const base = { cpu: { model: "CPU", cores: 8 }, freemem: 8 * GIB, listDir: () => [], readFile: () => undefined };

describe("lecteurs", () => {
  it("nvidia-smi : nom, mémoire totale et libre (Mio)", () => {
    const g = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 20480\r\n");
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", integrated: false, totalBytes: 24564 * 1024 ** 2, freeBytes: 20 * GIB });
    expect(g[0]!.backends).toContain("cuda");
  });

  it("nvidia-smi : version du pilote, si demandée", () => {
    const g = parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282, 10240, 580.88\n");
    expect(g[0]?.driver).toBe("580.88");
    expect(driverMajor(g[0])).toBe(580);
    expect(driverMajor(undefined)).toBe(0);
  });

  it("llama-server --list-devices : CUDA, Vulkan, Metal ; ignore le reste", () => {
    const d = parseLlamaDevices([
      "ggml_cuda_init: found 1 CUDA devices:",
      "Available devices:",
      "  CUDA0: NVIDIA GeForce RTX 4070 (12281 MiB, 11000 MiB free)",
      "  Vulkan0: AMD Radeon(TM) 8060S Graphics (98304 MiB, 97000 MiB free)",
      "  MTL0: Apple M3 Max (49152 MiB, 49151 MiB free)",
    ].join("\n"));
    expect(d.map((x) => x.backend)).toEqual(["cuda", "vulkan", "metal"]);
    expect(d[2]).toMatchObject({ name: "Apple M3 Max", freeBytes: 49151 * 1024 ** 2 });
  });

  it("registre : relie nom et mémoire par la clé ; ignore les cartes virtuelles", () => {
    const g = parseWindowsRegistry(regDesc("NVIDIA GeForce RTX 3060", "Intel(R) UHD Graphics 770", "Microsoft Basic Display Adapter"), regMem("0x300000000", "0x8000000"));
    expect(g.map((x) => x.name)).toEqual(["NVIDIA GeForce RTX 3060", "Intel(R) UHD Graphics 770"]);
    expect(g[0]).toMatchObject({ totalBytes: 12 * GIB, integrated: false });
    expect(g[1]).toMatchObject({ totalBytes: 128 * 1024 ** 2, integrated: true });
  });

  it("puce intégrée ou carte, d'après le nom", () => {
    expect(isIntegrated("amd", "AMD Radeon RX 7900 XTX")).toBe(false);
    expect(isIntegrated("amd", "AMD Radeon(TM) 8060S Graphics")).toBe(true);
    expect(isIntegrated("intel", "Intel(R) Arc(TM) A770 Graphics")).toBe(false);
    expect(isIntegrated("intel", "Intel(R) Arc(TM) 140V GPU (16GB)")).toBe(true);
    expect(isIntegrated("qualcomm", "Qualcomm(R) Adreno(TM) X1-85 GPU")).toBe(true);
  });

  it("linux : AMD intégrée (peu de VRAM, grande GTT) et carte AMD", () => {
    const files: Record<string, string> = {
      "/sys/class/drm/card0/device/vendor": "0x1002\n",
      "/sys/class/drm/card0/device/mem_info_vram_total": String(512 * 1024 ** 2),
      "/sys/class/drm/card0/device/mem_info_gtt_total": String(16 * GIB),
      "/sys/class/drm/card1/device/vendor": "0x1002\n",
      "/sys/class/drm/card1/device/mem_info_vram_total": String(16 * GIB),
      "/sys/class/drm/card1/device/mem_info_gtt_total": String(8 * GIB),
      "/sys/class/drm/card1/device/product_name": "Radeon RX 7800 XT",
    };
    const g = readLinuxDrm(() => ["card0", "card0-eDP-1", "card1", "renderD128"], (p) => files[p]);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ integrated: true, sharedBytes: 16 * GIB });
    expect(g[1]).toMatchObject({ name: "Radeon RX 7800 XT", integrated: false, totalBytes: 16 * GIB });
  });
});

describe("budget pour les modèles", () => {
  it("carte séparée : mémoire libre − 0,5 Go ; sans libre : totale − 15 %", () => {
    expect(modelBudget({ name: "x", vendor: "nvidia", integrated: false, freeBytes: 20 * GIB, backends: [], sources: [] }, 32 * GIB)).toEqual({ memory: "dedicated", bytes: 19.5 * GIB });
    expect(modelBudget({ name: "x", vendor: "nvidia", integrated: false, totalBytes: 12 * GIB, backends: [], sources: [] }, 32 * GIB).bytes).toBeCloseTo(12 * GIB * 0.85);
  });

  it("Apple : 2/3 de la RAM jusqu'à 36 Go, 3/4 au-delà, 8 Go laissés au système", () => {
    const apple = { name: "Apple M4", vendor: "apple" as const, integrated: true, backends: [], sources: [] };
    expect(modelBudget(apple, 16 * GIB)).toEqual({ memory: "unified", bytes: 8 * GIB });
    expect(modelBudget(apple, 36 * GIB).bytes).toBe(24 * GIB);
    expect(modelBudget(apple, 64 * GIB).bytes).toBe(48 * GIB);
  });

  it("PC à mémoire unifiée : part réservée + moitié de la RAM", () => {
    // Ryzen AI Max : 96 Go réservés par le BIOS, 32 Go vus par le système.
    const strix = { name: "AMD Radeon(TM) 8060S Graphics", vendor: "amd" as const, integrated: true, totalBytes: 96 * GIB, backends: [], sources: [] };
    expect(modelBudget(strix, 32 * GIB).bytes).toBe(112 * GIB);
    // Portable Intel 16 Go : la moitié, sans dépasser RAM − 8 Go ; la mémoire annoncée par le registre n'est pas ajoutée.
    const lunar = { name: "Intel(R) Arc(TM) 140V GPU", vendor: "intel" as const, integrated: true, totalBytes: 9 * GIB, backends: [], sources: [] };
    expect(modelBudget(lunar, 16 * GIB).bytes).toBe(8 * GIB);
    expect(modelBudget(lunar, 32 * GIB).bytes).toBe(16 * GIB);
  });

  it("aucune puce : 0", () => {
    expect(modelBudget(undefined, 16 * GIB)).toEqual({ memory: "none", bytes: 0 });
  });
});

describe("probeMachine", () => {
  it("PC avec carte NVIDIA et puce Intel : la carte gagne, avec sa mémoire libre", async () => {
    const m = await probeMachine({
      ...base, platform: "win32", totalmem: 32 * GIB,
      run: fake({
        "nvidia-smi": "NVIDIA GeForce RTX 4070, 12282, 10240\n",
        "/v DriverDesc": regDesc("Intel(R) UHD Graphics 770", "NVIDIA GeForce RTX 4070"),
        "qwMemorySize": regMem("0x8000000", "0x2ffe00000"),
      }),
    });
    expect(m.gpus).toHaveLength(2);
    expect(m.gpu?.name).toBe("NVIDIA GeForce RTX 4070");
    expect(m.memory).toBe("dedicated");
    expect(m.modelBytes).toBe(9.5 * GIB);
    expect(m.backends).toContain("cuda");
    expect(m.sources).toEqual(["nvidia-smi", "registre"]);
    expect(m.cpuBytes).toBe(26 * GIB);
  });

  it("Mac Apple Silicon : mémoire unifiée lue par sysctl", async () => {
    const m = await probeMachine({
      ...base, platform: "darwin", totalmem: 1,
      run: fake({ "hw.memsize": String(36 * GIB), "brand_string": "Apple M3 Pro\n" }),
    });
    expect(m.cpu).toBe("Apple M3 Pro");
    expect(m.ramBytes).toBe(36 * GIB);
    expect(m.memory).toBe("unified");
    expect(m.modelBytes).toBe(24 * GIB);
    expect(m.backends).toEqual(["metal"]);
  });

  it("Mac : llama.cpp donne la part réelle de Metal", async () => {
    const m = await probeMachine({
      ...base, platform: "darwin", llamaExe: "llama-server",
      run: fake({ "hw.memsize": String(64 * GIB), "brand_string": "Apple M3 Max", "--list-devices": "  MTL0: Apple M3 Max (49152 MiB, 40000 MiB free)" }),
    });
    expect(m.gpus).toHaveLength(1);
    expect(m.modelBytes).toBe(40000 * 1024 ** 2);
  });

  it("PC Ryzen AI Max : mémoire unifiée, Vulkan", async () => {
    const m = await probeMachine({
      ...base, platform: "win32", totalmem: 32 * GIB,
      run: fake({ "/v DriverDesc": regDesc("AMD Radeon(TM) 8060S Graphics"), "qwMemorySize": regMem("0x1800000000") }),
    });
    expect(m.memory).toBe("unified");
    expect(m.modelBytes).toBe(112 * GIB);
    expect(m.backends).toEqual(["vulkan", "rocm"]);
  });

  it("rien de lu, indice de l'appli : puce Intel intégrée estimée sur la RAM", async () => {
    const m = await probeMachine({ ...base, platform: "linux", totalmem: 16 * GIB, run: async () => undefined, hint: [{ vendorId: 0x8086 }] });
    expect(m.gpu?.vendor).toBe("intel");
    expect(m.memory).toBe("unified");
    expect(m.modelBytes).toBe(8 * GIB);
    expect(m.sources).toEqual(["appli"]);
  });

  it("rien du tout : pas de puce, le processeur reste", async () => {
    const m = await probeMachine({ ...base, platform: "linux", totalmem: 8 * GIB, run: async () => undefined });
    expect(m.gpu).toBeUndefined();
    expect(m.memory).toBe("none");
    expect(m.modelBytes).toBe(0);
    expect(m.cpuBytes).toBe(2 * GIB);
  });

  it("place libre sur le disque", async () => {
    const m = await probeMachine({ ...base, platform: "linux", run: async () => undefined, diskDir: "/x", statfs: () => ({ bavail: 1000, bsize: 4096 }) });
    expect(m.diskFreeBytes).toBe(4_096_000);
  });
});

describe("texte", () => {
  it("résumé en deux langues, sans nom de système", async () => {
    const m = await probeMachine({ ...base, platform: "darwin", run: fake({ "hw.memsize": String(16 * GIB), "brand_string": "Apple M4" }) });
    expect(tr(machineSummary(m), "fr")).toBe("Apple M4 · mémoire unifiée · 8 Go pour les modèles · RAM 16 Go");
    expect(tr(machineSummary(m), "en")).toBe("Apple M4 · unified memory · 8 GB for models · RAM 16 GB");
    expect(tr(gbText(9.4 * GIB), "fr")).toBe("9,5 Go");
  });
});
