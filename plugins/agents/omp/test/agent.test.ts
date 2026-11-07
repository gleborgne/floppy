import agent from "../src/index.ts";
import { agentPluginContract } from "../../../../packages/agent-cli/test/plugin-contract.ts";
agentPluginContract(agent, "omp");
