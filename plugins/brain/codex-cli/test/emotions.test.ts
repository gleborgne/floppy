// Étiquettes d'émotion du cerveau Codex : notifications simulées par un faux app-server (voir fixtures/fake-tagged.mjs).
import { fileURLToPath } from "node:url";
import codex from "../src/index.ts";
import { emotionContract } from "../../../../packages/agent-cli/test/emotion-contract.ts";

emotionContract({
  plugin: codex, agent: "codex", slot: "codex",
  fixture: fileURLToPath(new URL("./fixtures/fake-tagged.mjs", import.meta.url)),
  // Un nouveau message (item) après chaque outil.
  script: (steps) => {
    let item = 0;
    return JSON.stringify(steps.map((s) => "tool" in s ? (item++, { tool: s.tool }) : { item: `m${item}`, text: s.text }));
  },
});
