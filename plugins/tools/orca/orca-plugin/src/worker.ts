// Plugin Orca « Floppy » : prévient Floppy dès qu'un agent change d'état (au lieu d'attendre la vérification suivante).
// Tourne dans Orca (worker Node). Lit le port et le jeton dans <dossier de Floppy>/orca-bridge.json, écrit par
// le plugin `orca` de Floppy, puis envoie l'événement en HTTP sur 127.0.0.1. Floppy éteint : rien ne se passe.
// Aucune dépendance au dépôt Floppy : ce dossier se charge tel quel dans Orca (Orca transpile le TypeScript).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Ce dont le worker a besoin de l'API Orca (sous-ensemble de `orca/worker`). */
export interface OrcaApi {
  log(line: string): void;
  events: { on(event: "agent.status.changed", handler: (e: AgentEvent) => unknown): unknown };
}
export interface AgentEvent {
  workspaceId: string | null;
  paneKey: string;
  terminalId?: string;
  title?: string;
  state: string;
  mainAgent?: { state: string; outcome?: string };
}
export interface BridgeInfo { port: number; token: string }

/**
 * Où chercher le fichier du pont, dans l'ordre. Même dossier que floppyHome() côté Floppy : FLOPPY_HOME, sinon
 * LOCALAPPDATA/floppy, sinon ~/.local/share/floppy. Orca lance ses workers sans LOCALAPPDATA : sous Windows, on
 * ajoute donc ~/AppData/Local/floppy (sa valeur par défaut).
 */
export function bridgeFiles(
  env: Record<string, string | undefined> = process.env, home: string = homedir(), platform: string = process.platform,
  chosen: (base: string) => string | undefined = readChosenHome,
): string[] {
  const defaults = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "floppy"),
    platform === "win32" ? join(home, "AppData", "Local", "floppy") : undefined,
    join(home, ".local", "share", "floppy"),
  ].filter((b): b is string => !!b);
  // Répertoire de travail choisi par l'utilisateur : noté dans <dossier par défaut>/home.json.
  const picked = defaults.map((b) => chosen(b)).filter((b): b is string => !!b);
  const bases = [env.FLOPPY_HOME, ...picked, ...defaults].filter((b): b is string => !!b);
  return [...new Set(bases)].map((b) => join(b, "orca-bridge.json"));
}

function readChosenHome(base: string): string | undefined {
  try {
    const h = (JSON.parse(readFileSync(join(base, "home.json"), "utf8")) as { home?: unknown }).home;
    return typeof h === "string" && h ? h : undefined;
  } catch { return undefined; }
}

/** Premier fichier du pont lisible, ou la liste des essais ratés. */
export function readBridgeInfo(files: string[] = bridgeFiles(), read: (f: string) => string = (f) => readFileSync(f, "utf8")): BridgeInfo | string {
  const tried: string[] = [];
  for (const f of files) {
    try { return JSON.parse(read(f)) as BridgeInfo; } catch (e) { tried.push(`${f} : ${e instanceof Error ? e.message : String(e)}`); }
  }
  return tried.join(" ; ");
}

export interface BridgeDeps {
  readInfo?: () => BridgeInfo | undefined;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Envoie un message à Floppy. Relit le fichier si Floppy a redémarré (port ou jeton changés). Ne lève jamais. */
export function createBridge(deps: BridgeDeps = {}) {
  /** Raison du dernier échec, écrite au journal d'Orca (une fois par panne). */
  let why = "";
  const readInfo = deps.readInfo ?? (() => {
    const r = readBridgeInfo();
    if (typeof r === "string") { why = r; return undefined; }
    return r;
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  let info: BridgeInfo | undefined;
  let down = false;
  const post = async (i: BridgeInfo, msg: unknown): Promise<boolean> => {
    try {
      const r = await fetchImpl(`http://127.0.0.1:${i.port}/orca`, {
        method: "POST",
        headers: { Authorization: `Bearer ${i.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) why = `port ${i.port} : HTTP ${r.status}`;
      return r.ok;
    } catch (e) { why = `port ${i.port} : ${String(e)}`; return false; }
  };
  return async (msg: unknown): Promise<boolean> => {
    if (info && await post(info, msg)) return true;
    why = "pas de fichier";
    info = readInfo();
    const ok = !!info && await post(info, msg);
    if (ok !== !down) { down = !ok; deps.log?.(ok ? "Floppy joint." : `Floppy ne répond pas (pas lancé ?). ${why}`); }
    return ok;
  };
}

/** Garde seulement les vrais changements : Orca répète le même état plusieurs fois par seconde. */
export function changes() {
  const last = new Map<string, string>();
  return (e: AgentEvent): boolean => {
    const s = `${e.state}|${e.mainAgent?.outcome ?? ""}`;
    if (last.get(e.paneKey) === s) return false;
    last.set(e.paneKey, s);
    if (last.size > 500) last.clear();
    return true;
  };
}

export default function activate(orca: OrcaApi, deps: BridgeDeps = {}): void {
  const send = createBridge({ log: (l) => orca.log(l), ...deps });
  const changed = changes();
  void send({ kind: "hello" });
  orca.events.on("agent.status.changed", (e) => {
    if (!changed(e)) return;
    return send({
      kind: "agent",
      workspaceId: e.workspaceId,
      paneKey: e.paneKey,
      terminalId: e.terminalId,
      title: e.title,
      state: e.state,
      outcome: e.mainAgent?.outcome,
    });
  });
}
