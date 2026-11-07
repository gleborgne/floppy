import agent from "../src/index.ts";
import { fileURLToPath } from "node:url";
import { legacyAgentContract } from "../../../../packages/agent-cli/test/legacy-agent-contract.ts";
legacyAgentContract(agent, "claude", fileURLToPath(new URL("./fixtures/fake-brain.mjs", import.meta.url)));
