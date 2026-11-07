import agent from "../src/index.ts";
import { fileURLToPath } from "node:url";
import { legacyAgentContract } from "../../../../packages/agent-cli/test/legacy-agent-contract.ts";
legacyAgentContract(agent, "codex", fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url)));
