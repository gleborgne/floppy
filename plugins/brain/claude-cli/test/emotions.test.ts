// Étiquettes d'émotion du cerveau Claude : flux simulé par un faux CLI (voir fixtures/fake-tagged.mjs).
import { fileURLToPath } from "node:url";
import claude from "../src/index.ts";
import { emotionContract } from "../../../../packages/agent-cli/test/emotion-contract.ts";

emotionContract({
  plugin: claude, agent: "claude", slot: "claude",
  fixture: fileURLToPath(new URL("./fixtures/fake-tagged.mjs", import.meta.url)),
  // Un nouveau bloc de texte après chaque outil.
  script: (steps) => JSON.stringify(steps.flatMap((s, i): object[] => "tool" in s ? [{ tool: s.tool }]
    : [...(i > 0 && "tool" in steps[i - 1]! ? [{ block: true }] : []), { text: s.text }])),
});
