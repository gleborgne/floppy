// Client HTTP du daemon Reachy Mini (REST sous /api). Routes utilisées :
//   GET  /api/daemon/status   état du daemon (state, simulation_enabled, no_media, robot_name…)
//   POST /api/move/goto       aller à une pose (tête, antennes, corps) en `duration` secondes
//   POST /api/move/stop       arrêter un mouvement ({ uuid })
//   GET  /api/move/running    mouvements en cours
import { T, TextError } from "@floppy/core";

export interface DaemonStatus {
  robot_name?: string;
  state?: string;
  simulation_enabled?: boolean | null;
  mockup_sim_enabled?: boolean | null;
  no_media?: boolean;
  wireless_version?: boolean;
}

export const DEFAULT_URL = "http://reachy-mini.local:8000";

export function normUrl(u: string): string {
  let s = (u || DEFAULT_URL).trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

export class DaemonClient {
  readonly base: string;
  private readonly timeoutMs: number;
  constructor(url: string, timeoutMs = 2500) {
    this.base = normUrl(url);
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/api${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new TextError(T(`le daemon répond ${r.status} sur ${path}`, `the daemon answers ${r.status} on ${path}`));
    return (await r.json()) as T;
  }

  status(): Promise<DaemonStatus> { return this.call("GET", "/daemon/status"); }
  goto(body: unknown): Promise<{ uuid: string }> { return this.call("POST", "/move/goto", body); }
  stop(uuid: string): Promise<unknown> { return this.call("POST", "/move/stop", { uuid }); }
  running(): Promise<{ uuid: string }[]> { return this.call("GET", "/move/running"); }
}
