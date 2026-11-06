// Arguments de llama-server construits depuis les champs du modèle (optimisations par modèle : MoE, -ub, KV, MTP, vision, réflexion).
import { describe, it, expect } from "vitest";
import { buildArgs, splitArgs, type ModelValues } from "../src/index.ts";

const base: ModelValues & { id: string } = {
  id: "qwen", label: "Qwen", aliases: [], model: "q.gguf", spec: "none", placement: "gpu", gpuMargin: 6144,
  ctx: 32768, ubatch: 512, kv: "q8_0", reasoning: "off", thinkBudget: -1, args: ["-fa", "on", "-np", "1"],
};
const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

describe("buildArgs", () => {
  it("tout sur le GPU, valeurs de base", () => {
    const a = buildArgs(base, 8080);
    expect(after(a, "-ngl")).toBe("99");
    expect(after(a, "--fit")).toBe("off");
    expect(after(a, "-ctk")).toBe("q8_0");
    expect(after(a, "-ub")).toBe("512");
    expect(after(a, "-b")).toBe("2048");
    expect(after(a, "--reasoning")).toBe("off");
    expect(a).not.toContain("--spec-type");
    expect(a.slice(-4)).toEqual(["-fa", "on", "-np", "1"]);
  });
  it("Qwen MoE optimisé façon Codacus : experts en RAM, -ub 2048, MTP intégré, vision, réflexion après outils", () => {
    const a = buildArgs({ ...base, placement: "moe", nCpuMoe: 26, ubatch: 2048, spec: "mtp", mmproj: "mm.gguf", reasoning: "tools" }, 8080);
    expect(after(a, "--n-cpu-moe")).toBe("26");
    expect(after(a, "-ub")).toBe("2048");
    expect(after(a, "--spec-type")).toBe("draft-mtp");
    expect(a).not.toContain("-md"); // couches MTP dans le modèle
    expect(after(a, "-mm")).toBe("mm.gguf");
    expect(after(a, "--reasoning")).toBe("on"); // le cerveau la coupe par requête
  });
  it("MTP en fichier séparé, brouillon, n-grammes", () => {
    expect(buildArgs({ ...base, spec: "mtp", draft: "mtp.gguf" }, 1)).toEqual(expect.arrayContaining(["--spec-type", "draft-mtp", "-md", "mtp.gguf"]));
    expect(after(buildArgs({ ...base, spec: "draft", draft: "d.gguf" }, 1), "--spec-type")).toBe("draft-simple");
    expect(buildArgs({ ...base, spec: "draft" }, 1)).not.toContain("--spec-type"); // brouillon sans fichier : ignoré
    expect(after(buildArgs({ ...base, spec: "ngram" }, 1), "--spec-type")).toBe("ngram-mod");
  });
  it("placement auto : --fit on avec une marge, sans -ngl", () => {
    const a = buildArgs({ ...base, placement: "auto", gpuMargin: 8000 }, 1);
    expect(after(a, "--fit")).toBe("on");
    expect(after(a, "--fit-target")).toBe("8000");
    expect(a).not.toContain("-ngl");
  });
  it("les champs gagnent sur les arguments avancés (pas de doublon)", () => {
    const a = buildArgs({ ...base, ubatch: 1024, args: ["-fa", "on", "-ub", "128", "-ctk", "f16", "--n-cpu-moe", "3"] }, 1);
    expect(a.filter((x) => x === "-ub")).toHaveLength(1);
    expect(after(a, "-ub")).toBe("1024");
    expect(after(a, "-ctk")).toBe("q8_0");
    expect(a).not.toContain("--n-cpu-moe");
  });
});

describe("splitArgs", () => {
  it("retire les options gérées et garde le reste", () => {
    const r = splitArgs(["-fa", "on", "-ub", "2048", "--temp", "0.7", "--n-cpu-moe", "26"]);
    expect(r.args).toEqual(["-fa", "on", "--temp", "0.7"]);
    expect(r.found).toEqual({ "-ub": "2048", "--n-cpu-moe": "26" });
  });
});

describe("budget de réflexion", () => {
  it("ajoute --reasoning-budget quand la réflexion est active", () => {
    const b = { id: "q", label: "Q", aliases: [], model: "q.gguf", spec: "none" as const, placement: "gpu" as const, gpuMargin: 0, ctx: 4096, ubatch: 512, kv: "q8_0" as const, args: [] };
    expect(buildArgs({ ...b, reasoning: "tools", thinkBudget: 1024 }, 1)).toEqual(expect.arrayContaining(["--reasoning-budget", "1024"]));
    expect(buildArgs({ ...b, reasoning: "off", thinkBudget: 1024 }, 1)).not.toContain("--reasoning-budget");
    expect(buildArgs({ ...b, reasoning: "on", thinkBudget: -1 }, 1)).not.toContain("--reasoning-budget");
  });
});
