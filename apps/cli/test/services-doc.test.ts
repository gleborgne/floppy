// Carte des services de docs/spec/noyau.md : générée depuis les manifestes et les contrats, elle suit le code.
import { describe, it, expect } from "vitest";
import type { Manifest } from "@floppy/core";
import { generate, servicesMap, type ContractInfo } from "../src/services-doc.ts";

describe("carte des services", () => {
  it("la doc est à jour (sinon : npm run docs:services)", async () => {
    const { current, expected } = await generate();
    expect(current === expected, "docs/spec/noyau.md ne suit plus le code : lance `npm run docs:services`").toBe(true);
  });

  it("fournir, inject, optional et slot ont chacun leur flèche ; les plugins aux mêmes liens partagent un nœud", () => {
    const m = (id: string, x: Partial<Manifest>) => ({ id, version: "0", licence: "MIT", ...x }) as Manifest;
    const contracts: ContractInfo[] = [{ service: "llm", type: "LlmService", file: "x.ts", summary: "Un modèle", uses: ["brain"] }];
    const md = servicesMap([
      m("llm-a", { provides: ["llm"] }), m("llm-b", { provides: ["llm"] }),
      m("cerveau", { provides: ["brain"], inject: ["mcp"], optional: ["memory"], slots: [{ id: "brain.main", service: "llm", section: "s", label: "l" } as never] }),
      m("outil", {}),
    ], contracts);
    expect(md).toContain(`p_llm_a["llm-a<br/>llm-b"]`);
    expect(md).toContain("p_llm_a --> s_llm");
    expect(md).toContain("s_mcp --> p_cerveau");
    expect(md).toContain("s_memory -.-> p_cerveau");
    expect(md).toContain(`s_llm == "brain.main" ==> p_cerveau`);
    expect(md).toContain(`s_llm -. "type" .- s_brain`);
    expect(md).toContain("Sans service (outils seuls) : `outil`.");
    expect(md).toContain("| `llm` | `LlmService` (`x.ts`) ; cite `brain` | Un modèle | `llm-a`, `llm-b` | `cerveau` (slot `brain.main`) |");
  });
});
