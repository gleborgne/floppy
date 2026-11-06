// Recherche Hugging Face (réponses simulées) et bibliothèque du cerveau (téléchargement simulé).
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Kernel, tr } from "@floppy/core";
import { ggufGroups, memoryTag, pickGroups, quantOf, searchHf } from "../src/hf.ts";
import { makePlugin } from "../src/index.ts";
import { KNOWN_MODELS } from "../src/known-models.ts";

const SHA = "a".repeat(64);
const file = (path: string, size = 4e9, oid: string | null = SHA) => ({ type: "file", path, size: 130, ...(oid ? { lfs: { oid, size } } : {}) });

/** Faux Hugging Face : routes -> JSON, adresses demandées notées. */
function fakeHf(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const fn = (async (u: string) => {
    asked.push(u);
    const path = u.replace("https://huggingface.co/api/models", "");
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
    return key !== undefined ? new Response(JSON.stringify(routes[key])) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, asked };
}

describe("Hugging Face : lire les fichiers GGUF", () => {
  it("lit la quantification dans le nom", () => {
    expect(quantOf("Qwen3.5-9B-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("gemma-4-12b-it-qat-q4_0.gguf")).toBe("Q4_0");
    expect(quantOf("Q4_K_M/Big-Model-Q4_K_M-00001-of-00002.gguf")).toBe("Q4_K_M");
    expect(quantOf("model-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantOf("model.gguf")).toBeUndefined();
  });

  it("regroupe un modèle en plusieurs fichiers, ignore mmproj et ce qui n'est pas GGUF", () => {
    const g = ggufGroups([
      file("Q4_K_M/Big-Q4_K_M-00002-of-00002.gguf"), file("Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf"),
      file("Big-Q8_0.gguf"), file("mmproj-F16.gguf"), file("README.md"),
    ] as never);
    expect(g.map((x) => [x.name, x.parts.map((p) => p.path)])).toEqual([
      ["Q4_K_M/Big-Q4_K_M.gguf", ["Q4_K_M/Big-Q4_K_M-00001-of-00002.gguf", "Q4_K_M/Big-Q4_K_M-00002-of-00002.gguf"]],
      ["Big-Q8_0.gguf", ["Big-Q8_0.gguf"]],
    ]);
  });

  it("propose les quantifications préférées d'abord, trois au plus", () => {
    const names = ["m-Q2_K.gguf", "m-Q8_0.gguf", "m-Q4_K_M.gguf", "m-Q5_K_M.gguf", "m-Q4_0.gguf"].map((name) => ({ name }));
    expect(pickGroups(names).map((x) => x.name)).toEqual(["m-Q4_K_M.gguf", "m-Q4_0.gguf", "m-Q5_K_M.gguf"]);
  });

  it("estime la mémoire nécessaire", () => {
    expect(memoryTag(5_680_522_464)).toEqual({ fr: "≈ 7 Go de mémoire", en: "≈ 7 GB of memory" });
  });
});

describe("Hugging Face : chercher", () => {
  it("rend des modèles figés au commit, avec empreinte, licence et mémoire ; ignore les dépôts protégés", async () => {
    const hf = fakeHf({
      "": [{ id: "acme/Tiny-GGUF" }, { id: "acme/Locked-GGUF" }, { id: "acme/Broken-GGUF" }],
      "/acme/Tiny-GGUF": { id: "acme/Tiny-GGUF", sha: "c0ffee", gated: false, cardData: { license: "apache-2.0" } },
      "/acme/Tiny-GGUF/tree/main": [file("Tiny-Q8_0.gguf", 2e9), file("Tiny-Q4_K_M.gguf", 1e9), file("Tiny-Q2_K.gguf", 5e8, null)],
      "/acme/Locked-GGUF": { id: "acme/Locked-GGUF", sha: "1", gated: "manual" },
      "/acme/Locked-GGUF/tree/main": [file("Locked-Q4_K_M.gguf")],
    });
    const out = await searchHf("tiny model", hf.fn);
    expect(hf.asked[0]).toContain("search=tiny%20model&filter=gguf&sort=downloads");
    expect(out.map((e) => e.id)).toEqual(["hf/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", "hf/acme/Tiny-GGUF/Tiny-Q8_0.gguf"]);
    expect(out[0]).toMatchObject({
      label: "Tiny · Q4_K_M", licence: { name: "apache-2.0", url: "https://huggingface.co/acme/Tiny-GGUF" },
      files: [{ url: "https://huggingface.co/acme/Tiny-GGUF/resolve/c0ffee/Tiny-Q4_K_M.gguf", path: "hf/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", size: 1e9, sha256: SHA }],
    });
    expect(tr(out[0]!.tags![0], "fr")).toBe("≈ 3 Go de mémoire");
  });

  it("une erreur de la recherche elle-même remonte", async () => {
    const hf = fakeHf({});
    await expect(searchHf("x", hf.fn)).rejects.toThrow(/404/);
  });
});

describe("bibliothèque du cerveau", () => {
  it("modèles choisis : adresses figées, une empreinte, une estimation de mémoire", () => {
    for (const m of KNOWN_MODELS) {
      expect(m.files[0]!.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(m.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.tags?.some((t) => tr(t, "fr").includes("Go de mémoire"))).toBe(true);
    }
  });

  it("un résultat de recherche téléchargé devient un modèle du cerveau", async () => {
    const body = Buffer.from("gguf");
    const sha = createHash("sha256").update(body).digest("hex");
    const result = { id: "hf/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", label: "Tiny · Q4_K_M", files: [{ url: "https://huggingface.co/acme/Tiny-GGUF/resolve/c0ffee/Tiny-Q4_K_M.gguf", path: "hf/acme/Tiny-GGUF/Tiny-Q4_K_M.gguf", size: body.length, sha256: sha }] };
    const fetch = (async () => new Response(body)) as unknown as typeof globalThis.fetch;
    const k = new Kernel({ logger: () => {}, plugins: [makePlugin([], async () => [result])], downloads: { fetch } });
    await k.applyConfig({ plugins: [{ id: "llm", plugin: "llm-llamacpp", config: { models: {} } }], services: {} });
    const prov = async (id: string) => (await k.items.snapshot()).find((p) => p.id === id)!;
    expect((await prov("llm-local-library")).can.search).toBe(true);
    const found = await k.items.run({ op: "search", provider: "llm-local-library", query: "tiny" }, "ui");
    expect(found.items?.[0]?.actions?.map((a) => a.id)).toEqual(["download"]);
    await k.items.run({ op: "action", provider: "llm-local-library", id: result.id, action: "download" }, "ui");
    for (let i = 0; i < 100 && !(await prov("llm-local")).items.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await prov("llm-local")).items[0]).toMatchObject({ label: "Tiny · Q4_K_M", values: { model: join(k.modelsDir, "llm", "hf", "acme", "Tiny-GGUF", "Tiny-Q4_K_M.gguf") } });
    // Toujours dans la bibliothèque (installé), même sans nouvelle recherche.
    expect((await prov("llm-local-library")).items.map((x) => x.id)).toEqual([result.id]);
  });
});
