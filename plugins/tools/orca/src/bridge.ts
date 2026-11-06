// Pont avec le plugin Orca « Floppy » (dossier ../orca-plugin) : Orca prévient Floppy dès qu'un agent change d'état.
// HTTP sur 127.0.0.1, port libre, jeton aléatoire. Port et jeton sont écrits dans <home>/orca-bridge.json
// (dossier de l'utilisateur, lisible par lui seul), où le plugin Orca les lit. Même principe que control.ts.
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kind } from "./speech.ts";

/** Le pont est « en direct » s'il a parlé depuis moins de 10 min (le plugin Orca dit bonjour en démarrant). */
export const BRIDGE_LIVE_MS = 10 * 60_000;
/** Pont en direct : une vérification par minute suffit (filet de sécurité). */
export const BRIDGE_POLL_MS = 60_000;
/** Un état reçu du pont gagne pendant 30 s sur la vérification, qui peut voir un état plus ancien. */
export const EVENT_WINS_MS = 30_000;
const MAX_BODY = 64 * 1024;

/** Message du plugin Orca. Vient d'un autre programme : chaque champ est vérifié avant usage. */
export interface BridgeEvent {
  kind?: unknown;
  workspaceId?: unknown;
  paneKey?: unknown;
  terminalId?: unknown;
  title?: unknown;
  state?: unknown;
  outcome?: unknown;
}

/** États d'un événement Orca : working, blocked, waiting, done (+ outcome du agent principal). */
export function kindOfEvent(state: unknown, outcome: unknown): Kind {
  const s = String(state ?? "").toLowerCase();
  if (s === "working") return "en_cours";
  if (s === "blocked" || s === "waiting") return "en_attente";
  if (outcome === "interruption" || outcome === "cancellation") return "interrompu";
  return "termines";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ko) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { ko(new Error("trop gros")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", ko);
  });
}

/** Ouvre la porte d'entrée. Rend la fonction qui la ferme (et retire le fichier, s'il est encore à nous). */
export async function startBridge(home: string, onEvent: (e: BridgeEvent) => void, warn: (msg: string, data?: Record<string, unknown>) => void): Promise<() => Promise<void>> {
  const token = randomBytes(24).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const file = join(home, "orca-bridge.json");
  const server = createServer((req, res) => {
    const reply = (status: number): void => { res.writeHead(status); res.end(); };
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(401);
    if (req.method !== "POST" || req.url !== "/orca") return reply(404);
    readBody(req).then((raw) => {
      let e: unknown;
      try { e = JSON.parse(raw); } catch { return reply(400); }
      if (!e || typeof e !== "object" || Array.isArray(e)) return reply(400);
      reply(204);
      onEvent(e as BridgeEvent);
    }, () => reply(413));
  });
  try {
    await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(0, "127.0.0.1", ok); });
  } catch (e) {
    warn("Pont Orca : impossible d'ouvrir le port local, on garde la vérification régulière.", { erreur: String(e) });
    return async () => {};
  }
  const port = (server.address() as { port: number }).port;
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { encoding: "utf8", mode: 0o600 });
  return async () => {
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeAllConnections();
    await closed;
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as { port?: number };
      if (cur.port === port) rmSync(file);
    } catch { /* déjà retiré */ }
  };
}
