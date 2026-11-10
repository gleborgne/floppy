// Fournisseur par défaut de chaque service : épinglé. Le noyau choisit, à défaut de slot ou de `services:` dans la
// config, le premier fournisseur actif dans l'ORDRE DES ENTRÉES DE LA CONFIG (floppy.yml), pas dans l'ordre du catalogue.
// Ce test lance le vrai noyau avec la config d'exemple, sur des plugins de remplacement qui ne gardent du manifeste
// que `provides` : changer l'ordre de la config d'exemple, ou ce qu'un plugin fournit, change un défaut et casse ici.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { Kernel, definePlugin, loadConfigFile } from "@floppy/core";
import { loadCatalog } from "../src/catalog.ts";

const example = fileURLToPath(new URL("../../../floppy.example.yml", import.meta.url));

/** Fournisseur par défaut de chaque service, avec la config d'exemple. `agent` : aucun (seul `claude` en fournit, et il est configuré `as: [delegate]`). */
const DEFAULTS: Record<string, string | undefined> = {
  agent: undefined,
  agentTracking: "orca",
  avatars: "body-electron",
  body: "body-hub",
  brain: "brain-aisdk", // `claude` (brain-claude-cli) vient avant dans la config mais n'est que `delegate`
  // Plusieurs sources du point du matin : le point les lit toutes (ctx.offers), ce fournisseur par défaut ne sert pas.
  brief: "agent-jobs",
  coder: "coder",
  completion: "llm-llamacpp",
  delegate: "brain-claude-cli",
  documents: "documents",
  live: "live-gemini",
  llm: "llm-llamacpp",
  mcp: "tools",
  memory: "memory",
  notify: "notify-telegram",
  search: "websearch",
  stt: "stt-sherpa",
  task: "watch",
  tts: "tts-audiocpp",
  vad: "stt-sherpa",
  vocabulary: "vocabulary",
  voice: "voice-listen",
  wakeword: "wakeword-stt",
};

describe("fournisseur par défaut de chaque service (config d'exemple)", () => {
  it("est celui d'aujourd'hui", async () => {
    const { plugins } = await loadCatalog({ dev: false });
    const cfg = loadConfigFile(example);
    // Remplaçants : mêmes ids, mêmes `provides` ; `as` (brain-claude-cli) restreint ce que l'entrée fournit, comme le vrai plugin.
    const stubs = plugins.map((p) => definePlugin({
      manifest: { id: p.manifest.id, version: "0", licence: "MIT", provides: p.manifest.provides ?? [] },
      apply(ctx, entry: { as?: string[] } | undefined) {
        for (const s of p.manifest.provides ?? []) {
          if (Array.isArray(entry?.as) && !entry.as.includes(s)) continue;
          ctx.provide(s, { id: p.manifest.id });
        }
      },
    }));
    const k = new Kernel({ logger: () => {}, plugins: stubs });
    try {
      await k.applyConfig(cfg);
      const services = [...new Set(plugins.flatMap((p) => p.manifest.provides ?? []))].sort();
      const got: Record<string, string | undefined> = {};
      for (const s of services) got[s] = (k.service(s) as { id: string } | undefined)?.id;
      expect(got).toEqual(DEFAULTS);
    } finally { await k.stopAll(); }
  });
});
