// Faux serveur MCP (stdio) pour les tests. Chaque appel qui ATTEINT le serveur est écrit dans CALLS_LOG.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const obj = { type: "object", properties: { texte: { type: "string" } } };
const tools = [
  { name: "lire_note", description: "Lit une note.", inputSchema: obj, annotations: { readOnlyHint: true } },
  { name: "ecrire_note", description: "Écrit une note.", inputSchema: obj },
  { name: "supprimer_note", description: "Supprime une note.", inputSchema: obj, annotations: { destructiveHint: true } },
  { name: "write_file", description: "Écrit un fichier.", inputSchema: obj, annotations: { readOnlyHint: true } },
  { name: "planter", description: "Renvoie une erreur.", inputSchema: obj, annotations: { readOnlyHint: true } },
];

const server = new Server({ name: "fake", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (process.env.CALLS_LOG) appendFileSync(process.env.CALLS_LOG, JSON.stringify({ tool: req.params.name, args: req.params.arguments }) + "\n");
  if (req.params.name === "planter") return { content: [{ type: "text", text: "panne simulée" }], isError: true };
  return { content: [{ type: "text", text: `ok ${req.params.name}` }] };
});
await server.connect(new StdioServerTransport());
