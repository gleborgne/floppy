// Porte d'entrée de la boîte aux lettres : HTTP sur 127.0.0.1, port libre, jeton aléatoire.
// Port et jeton sont écrits dans <home>/inbox.json, où les apps les lisent. Sous Windows, `mode` ne fait rien : ce
// sont les droits du dossier de Floppy qui protègent le jeton des autres comptes. Même principe que control.ts et le pont Orca.
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "@floppy/core";

export const INBOX_FILE = "inbox.json";
export const INBOX_PATH = "/inbox";
const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ko) => {
    let size = 0;
    let parts: Buffer[] = [];
    // Trop gros : on lit jusqu'au bout sans rien garder, pour pouvoir répondre 413 (couper la connexion ne dit rien à l'app).
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { parts = []; return; }
      parts.push(c);
    });
    req.on("end", () => (size > MAX_BODY ? ko(new Error("trop gros")) : ok(Buffer.concat(parts).toString("utf8"))));
    req.on("error", ko);
  });
}

/**
 * Ouvre la porte. `onPost` reçoit le JSON (objet) et rend le code HTTP à répondre (204, 400, 403…).
 * Rend la fonction qui la ferme (et retire le fichier, s'il est encore à nous), ou undefined si le port ne s'ouvre pas.
 */
export async function startInbox(home: string, onPost: (body: Record<string, unknown>) => number): Promise<(() => Promise<void>) | undefined> {
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const file = join(home, INBOX_FILE);
  const server = createServer((req, res) => {
    const reply = (status: number): void => { res.writeHead(status); res.end(); };
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(401);
    if (req.method !== "POST" || req.url !== INBOX_PATH) return reply(404);
    readBody(req).then((raw) => {
      let e: unknown;
      try { e = JSON.parse(raw); } catch { return reply(400); }
      if (!e || typeof e !== "object" || Array.isArray(e)) return reply(400);
      let status = 500;
      try { status = onPost(e as Record<string, unknown>); } catch { /* 500 */ }
      reply(status);
    }, () => reply(413));
  });
  // Attentes bornées : un message s'envoie en une fois ; une connexion lente ou muette est coupée.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.maxConnections = 32;
  try {
    await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(0, "127.0.0.1", ok); });
  } catch {
    return undefined;
  }
  const port = (server.address() as { port: number }).port;
  writeJsonAtomic(file, { port, token, pid: process.pid }, { mode: 0o600 });
  return async () => {
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeAllConnections();
    await closed;
    const cur = readJsonFile<{ port?: number }>(file);
    if (cur?.port === port) { try { rmSync(file); } catch { /* déjà retiré */ } }
  };
}
