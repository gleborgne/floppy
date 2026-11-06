// Faux serveur MCP (stdio) qui ne répond jamais (ou après DELAY_MS) : pour tester le délai de connexion.
import { writeFileSync } from "node:fs";
if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
const delay = Number(process.env.DELAY_MS ?? 0);
if (delay > 0) {
  await new Promise((r) => setTimeout(r, delay));
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "slow", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await server.connect(new StdioServerTransport());
} else {
  setInterval(() => {}, 1000);
}
