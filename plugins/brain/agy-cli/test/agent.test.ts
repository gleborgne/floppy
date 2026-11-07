import agent from "../src/index.ts";
import { fileURLToPath } from "node:url";
import { legacyAgentContract } from "../../../../packages/agent-cli/test/legacy-agent-contract.ts";
legacyAgentContract(agent, "antigravity", fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url)));
