// Point de contrôle local : la CLI parle au noyau qui tourne déjà.
// HTTP sur 127.0.0.1, port libre, jeton aléatoire. Port et jeton sont écrits dans <home>/control.json
// (dossier de l'utilisateur, lisible par lui seul).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "./plugin/kernel.ts";
import { errorText, T, TextError } from "./i18n.ts";
import { onboardingFor } from "./onboarding.ts";

export { floppyHome } from "./util/home.ts";

export interface ControlInfo { port: number; token: string; pid: number }

export interface ControlHandlers {
  reload?: () => Promise<void>;
}

export async function startControl(kernel: Kernel, home: string, handlers: ControlHandlers = {}): Promise<() => Promise<void>> {
  const token = randomBytes(24).toString("hex");
  const file = join(home, "control.json");
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: String(e), text: errorText(e) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${token}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(res, 401, { error: "jeton invalide" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = req.method === "POST" ? await readJson(req) : {};
    switch (`${req.method} ${url.pathname}`) {
      case "GET /status": return send(res, 200, { settings: kernel.assistantSettings, plugins: kernel.status() });
      case "GET /log": return send(res, 200, kernel.audit.tail(Number(url.searchParams.get("n") ?? 50)));
      case "GET /approvals": return send(res, 200, kernel.approvals.pending());
      case "POST /approve": {
        const ok = kernel.approvals.respond(String(body.id), Boolean(body.ok), "cli");
        return send(res, ok ? 200 : 404, { ok });
      }
      case "GET /settings": return send(res, 200, kernel.settings.list());
      case "POST /settings": return send(res, 200, await kernel.settings.change(String(body.key), body.value, "cli"));
      case "POST /settings/undo": return send(res, 200, await kernel.settings.undo("cli"));
      case "GET /items": return send(res, 200, await kernel.items.snapshot());
      // Ce que Floppy lit de la machine, et les niveaux du premier lancement (CLI `floppy machine`).
      case "GET /onboarding": {
        const { candidates: _c, ...plan } = await onboardingFor(kernel).plan({ fresh: true });
        return send(res, 200, plan);
      }
      case "POST /items": return send(res, 200, await kernel.items.run(body as never, "cli"));
      case "POST /restart": await kernel.restart(String(body.id)); return send(res, 200, { ok: true });
      // Appel direct d'un outil (CLI `floppy tool`, mode debug) : même chemin que le modèle, accord compris.
      case "POST /tool": {
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {};
        return send(res, 200, await kernel.tools.call(String(body.name ?? ""), args, { caller: "cli", origin: "cli" }));
      }
      case "POST /reload":
        if (!handlers.reload) return send(res, 501, { error: "pas de fichier de config" });
        await handlers.reload();
        return send(res, 200, { ok: true });
      default: return send(res, 404, { error: "inconnu" });
    }
  }

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  writeFileSync(file, JSON.stringify({ port, token, pid: process.pid } satisfies ControlInfo), { encoding: "utf8", mode: 0o600 });
  return async () => {
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeAllConnections(); // avant d'attendre : une connexion gardée ouverte bloquerait close()
    await closed;
    try {
      const cur = JSON.parse(readFileSync(file, "utf8")) as ControlInfo;
      if (cur.pid === process.pid) rmSync(file);
    } catch { /* déjà supprimé */ }
  };
}

/** Client de la CLI. */
export async function controlCall(home: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const file = join(home, "control.json");
  if (!existsSync(file)) throw new TextError(T("le noyau ne tourne pas (pas de control.json). Lancez : floppy start", "the kernel is not running (no control.json). Run: floppy start"));
  const info = JSON.parse(readFileSync(file, "utf8")) as ControlInfo;
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new TextError(T(`le noyau ne répond pas (pid ${info.pid}, port ${info.port}). Est-il arrêté ?`, `the kernel does not answer (pid ${info.pid}, port ${info.port}). Is it stopped?`));
  }
  return { status: r.status, data: await r.json() };
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 1_000_000) { req.destroy(); throw new Error("requête trop grande"); } // refusé pendant la lecture, pas après
  }
  return s ? JSON.parse(s) : {};
}
