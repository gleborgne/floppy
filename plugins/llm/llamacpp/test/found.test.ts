// Modèles déjà sur la machine (LM Studio, Ollama) : trouvés, puis ajoutés à la liste sans rien télécharger.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@floppy/core";
import llm from "../src/index.ts";
import { scanFolders, scanOllama, ollamaDir, isGguf } from "../src/found.ts";

const GGUF = (bytes = 64) => Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(bytes)]);
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** Faux dossier d'Ollama : un manifeste par modèle, la couche « model » dans blobs/. */
function fakeOllama(): string {
  const d = mkdtempSync(join(tmpdir(), "ollama-"));
  const put = (parts: string[], layers: { mediaType: string; digest: string; size: number }[]) => {
    mkdirSync(join(d, "manifests", ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(d, "manifests", ...parts), JSON.stringify({ schemaVersion: 2, layers }));
  };
  mkdirSync(join(d, "blobs"));
  writeFileSync(join(d, "blobs", "sha256-" + "a".repeat(64)), GGUF());
  writeFileSync(join(d, "blobs", "sha256-" + "b".repeat(64)), Buffer.from("pas un gguf"));
  writeFileSync(join(d, "blobs", "sha256-" + "c".repeat(64)), GGUF());
  put(["registry.ollama.ai", "library", "llama3.2", "3b"], [
    { mediaType: "application/vnd.ollama.image.template", digest: digest("f"), size: 10 },
    { mediaType: "application/vnd.ollama.image.model", digest: digest("a"), size: 2_000_000_000 },
  ]);
  put(["registry.ollama.ai", "library", "broken", "latest"], [{ mediaType: "application/vnd.ollama.image.model", digest: digest("b"), size: 11 }]);
  put(["hf.co", "bartowski", "Qwen3-8B-GGUF", "Q4_K_M"], [{ mediaType: "application/vnd.ollama.image.model", digest: digest("c"), size: 5_000_000_000 }]);
  return d;
}

describe("modèles trouvés sur la machine", () => {
  it("Ollama : le nom du modèle et son fichier GGUF ; un blob qui n'est pas du GGUF est ignoré", () => {
    const d = fakeOllama();
    const list = scanOllama(d);
    expect(list.map((m) => [m.label, m.size, m.from])).toEqual(expect.arrayContaining([
      ["llama3.2:3b", 2_000_000_000, "ollama"],
      ["bartowski/Qwen3-8B-GGUF:Q4_K_M", 5_000_000_000, "ollama"],
    ]));
    expect(list).toHaveLength(2);
    expect(isGguf(list[0]!.file)).toBe(true);
    expect(scanOllama(join(d, "absent"))).toEqual([]);
  });

  it("dossier d'Ollama : OLLAMA_MODELS d'abord", () => {
    expect(ollamaDir({ OLLAMA_MODELS: "/x/models" }, "/home/a")).toBe("/x/models");
    expect(ollamaDir({}, "/home/a")).toBe(join("/home/a", ".ollama", "models"));
  });

  it("LM Studio : un modèle en plusieurs morceaux compte une fois", () => {
    const d = mkdtempSync(join(tmpdir(), "lms-"));
    mkdirSync(join(d, "pub", "repo"), { recursive: true });
    for (const f of ["big-00001-of-00002.gguf", "big-00002-of-00002.gguf", "small.gguf", "mmproj-small.gguf"]) writeFileSync(join(d, "pub", "repo", f), GGUF());
    expect(scanFolders([d]).map((m) => m.label).sort()).toEqual(["big", "small"]);
  });

  it("fournisseur « déjà sur ta machine » : rien à télécharger ; « use » l'ajoute à la liste des cerveaux", async () => {
    const d = mkdtempSync(join(tmpdir(), "lms-"));
    writeFileSync(join(d, "gemma-3-12b-Q4_K_M.gguf"), GGUF());
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "found-home-")), plugins: [llm] });
    try {
      await k.applyConfig({ plugins: [{ id: "llm", plugin: "llm-llamacpp", config: { scanDirs: [d], ollama: false, exe: "llama-server" } }] });
      const snap = async () => (await k.items.snapshot()).find((p) => p.id === "llm-local-found")!;
      const it = (await snap()).items[0]!;
      expect(it).toMatchObject({ label: "gemma-3-12b-Q4_K_M", service: "llm", size: 0, status: "ok" });
      expect(it.uses).toBeUndefined();
      expect((await k.items.run({ op: "action", provider: "llm-local-found", id: it.id, action: "use" }, "ui")).ok).toBe(true);
      const after = (await snap()).items[0]!;
      expect(after.uses).toBeTruthy();
      const list = (await k.items.snapshot()).find((p) => p.id === "llm-local")!;
      expect(list.items.find((i) => i.id === after.uses)?.label).toBe("gemma-3-12b-Q4_K_M (LM Studio)");
    } finally { await k.stopAll(); }
  });
});
