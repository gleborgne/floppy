// Jeton d'accès Azure via la CLI `az`, gardé en mémoire et renouvelé 5 minutes avant la fin.
// Le jeton n'est jamais écrit dans les journaux.
import { T, TextError, type Context } from "@floppy/core";

const MARGE_MS = 5 * 60_000;

/**
 * Lance `az account get-access-token` par ctx.exec. Arguments fixes : seule la ressource vient de la config (déjà validée).
 * Windows : az est un script .cmd, lancé par cmd.exe (Node refuse un .cmd sans shell).
 */
export async function runAz(resource: string, exec: Context["exec"]): Promise<string> {
  const args = ["account", "get-access-token", "--resource", resource, "-o", "json"];
  try {
    const r = process.platform === "win32"
      ? await exec("cmd.exe", ["/d", "/s", "/c", `"az ${args.map((a) => `"${a.replace(/"/g, "")}"`).join(" ")}"`], { verbatim: true, timeoutMs: 60_000, maxBuffer: 1024 * 1024 })
      : await exec("az", args, { timeoutMs: 60_000, maxBuffer: 1024 * 1024 });
    return r.stdout;
  } catch (e) {
    const why = String(e instanceof Error ? e.message : e).trim().split("\n").pop();
    throw new TextError(T(`az a échoué : ${why}`, `az failed: ${why}`));
  }
}

export function parseAzToken(json: string): { token: string; expiresAt: number } {
  const o = JSON.parse(json) as { accessToken?: string; expires_on?: number | string; expiresOn?: string };
  if (!o.accessToken) throw new TextError(T("az n'a pas rendu de jeton", "az returned no token"));
  let expiresAt = 0;
  if (o.expires_on !== undefined && Number.isFinite(Number(o.expires_on))) expiresAt = Number(o.expires_on) * 1000;
  else if (o.expiresOn) expiresAt = new Date(o.expiresOn.replace(" ", "T")).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) expiresAt = Date.now() + 30 * 60_000;
  return { token: o.accessToken, expiresAt };
}

/** Renvoie une fonction qui donne un jeton valide (en le renouvelant au besoin). */
export function azTokenProvider(resource: string, run: (r: string) => Promise<string>): () => Promise<string> {
  let cache: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (cache && cache.expiresAt - Date.now() > MARGE_MS) return cache.token;
    pending ??= run(resource).then((out) => { cache = parseAzToken(out); return cache.token; }).finally(() => { pending = undefined; });
    return pending;
  };
}

/** `fetch` qui ajoute `Authorization: Bearer <jeton>` à chaque requête. */
export function bearerFetch(getToken: () => Promise<string>): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${await getToken()}`);
    return fetch(url, { ...init, headers });
  };
}
