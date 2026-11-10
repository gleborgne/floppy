// Étiquettes d'émotion du cerveau Antigravity : étapes simulées par un faux agy (voir fixtures/fake-tagged.mjs).
import { fileURLToPath } from "node:url";
import agy from "../src/index.ts";
import { emotionContract } from "../../../../packages/agent-cli/test/emotion-contract.ts";

emotionContract({
  plugin: agy, agent: "antigravity", slot: "antigravity",
  fixture: fileURLToPath(new URL("./fixtures/fake-tagged.mjs", import.meta.url)),
  // Une nouvelle étape à chaque outil, et le texte suivant en est une de plus.
  script: (steps) => {
    let step = 1;
    return JSON.stringify(steps.map((s) => "tool" in s ? { tool: s.tool, step: ++step } : { step, text: s.text }));
  },
});
