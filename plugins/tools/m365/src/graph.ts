// Connexion à Microsoft Graph sans WAM : flux « code d'appareil » (l'utilisateur tape un code sur
// https://login.microsoft.com/device), avec l'application publique de Microsoft pour les outils Graph
// (« Microsoft Graph Command Line Tools », celle de Graph PowerShell). Permissions déléguées : lecture, plus l'ajout
// dans l'agenda et l'envoi de messages Teams (chaque écriture passe par une carte d'accord).
//
// Le jeton de rafraîchissement est gardé dans le trousseau (Gestionnaire d'identification Windows), jamais dans un
// fichier. Le jeton d'accès reste en mémoire et est renouvelé seul.

import { T, TextError, type Text } from "@floppy/core";

export const CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
// Calendars.ReadWrite : ajouter un rendez-vous ou un rappel (chaque ajout demande l'accord de l'utilisateur).
// Teams : lire les conversations, envoyer un message (ChatMessage.Send, Chat.Create pour une 1re discussion),
// voir ses équipes et leurs canaux, publier dans un canal, voir la présence d'un collègue.
// Toutes ces permissions s'accordent par l'utilisateur lui-même (pas besoin d'administrateur).
export const SCOPES = [
  "Mail.Read", "Calendars.ReadWrite", "People.Read", "Files.Read.All", "User.Read", "User.ReadBasic.All",
  "Chat.Read", "ChatMessage.Send", "Chat.Create", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send",
  "Presence.Read.All", "offline_access",
].join(" ");
/** Lire les messages des canaux d'équipe : demande l'accord d'un administrateur Microsoft. Demandée à part. */
export const CHANNEL_READ = "ChannelMessage.Read.All";
/** Au renouvellement : toutes les permissions déjà accordées (anciennes connexions comprises). */
const REFRESH_SCOPE = "https://graph.microsoft.com/.default offline_access";
const AUTH = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
export const GRAPH = "https://graph.microsoft.com/v1.0";

export interface TokenStore {
  get(): string | undefined;
  set(refresh: string): void;
  clear(): void;
}

export interface DeviceCode { userCode: string; url: string; expiresIn: number; poll: () => Promise<{ ok: boolean; text: Text; who?: string }> }

/** Le `fetch` du plugin (`ctx.fetch`) ou un faux (tests). Appels d'authentification : délai par défaut de ctx.fetch (30 s) ; appels Graph : 20 s ci-dessous. */
type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export class GraphAuth {
  private access?: { token: string; until: number; scopes?: Set<string> };
  private readonly store: TokenStore;
  private readonly fetchImpl: Fetch;
  who?: string;

  constructor(store: TokenStore, fetchImpl: Fetch) {
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  get connected(): boolean {
    return !!this.store.get();
  }

  /** Démarre la connexion : rend le code à taper et une fonction qui attend la fin. */
  async start(signal?: AbortSignal, extra = ""): Promise<DeviceCode> {
    const scope = `${SCOPES} ${extra}`.trim();
    const r = await this.fetchImpl(`${AUTH}/devicecode`, { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, scope }) });
    const dc = await r.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error_description?: string };
    if (!dc.device_code || !dc.user_code) {
      throw dc.error_description ? new Error(dc.error_description.split("\n")[0]) : new TextError(T("Microsoft n'a pas donné de code", "Microsoft gave no code"));
    }
    const poll = async (): Promise<{ ok: boolean; text: Text; who?: string }> => {
      const end = Date.now() + (dc.expires_in ?? 900) * 1000;
      while (Date.now() < end && !signal?.aborted) {
        await new Promise((ok) => setTimeout(ok, (dc.interval ?? 5) * 1000));
        const t = await this.token({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code! });
        if (t.error === "authorization_pending" || t.error === "slow_down") continue;
        if (t.error) return { ok: false, text: t.error_description?.split("\n")[0] ?? t.error };
        this.keep(t);
        await this.me().catch(() => {});
        return { ok: true, text: T("connecté", "signed in"), ...(this.who ? { who: this.who } : {}) };
      }
      return { ok: false, text: T("le code a expiré", "the code expired") };
    };
    return { userCode: dc.user_code, url: dc.verification_uri ?? "https://login.microsoft.com/device", expiresIn: dc.expires_in ?? 900, poll };
  }

  logout(): void {
    this.store.clear();
    this.access = undefined;
    this.who = undefined;
  }

  private async token(body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
    const r = await this.fetchImpl(`${AUTH}/token`, { method: "POST", body: new URLSearchParams({ client_id: CLIENT_ID, ...body }) });
    return r.json() as never;
  }

  private keep(t: { access_token?: string; refresh_token?: string; expires_in?: number }): void {
    if (t.refresh_token) this.store.set(t.refresh_token);
    if (t.access_token) {
      const scopes = scopesOf(t.access_token);
      this.access = { token: t.access_token, until: Date.now() + ((t.expires_in ?? 3600) - 120) * 1000, ...(scopes ? { scopes } : {}) };
    }
  }

  /** Jeton d'accès valide (renouvelé avec le jeton de rafraîchissement si besoin). */
  async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const refresh = this.store.get();
    if (!refresh) throw new NotConnected();
    const t = await this.token({ grant_type: "refresh_token", refresh_token: refresh, scope: REFRESH_SCOPE });
    if (t.error || !t.access_token) {
      if (t.error === "invalid_grant") this.store.clear();
      throw new NotConnected(t.error_description?.split("\n")[0]);
    }
    this.keep(t);
    return this.access!.token;
  }

  /** Permissions accordées (lues dans le jeton). undefined si on ne sait pas les lire. */
  async granted(): Promise<Set<string> | undefined> {
    await this.accessToken();
    return this.access?.scopes;
  }

  /** Permissions de la liste qui manquent (vide si on ne sait pas les lire). */
  async missing(scopes: string[]): Promise<string[]> {
    const s = await this.granted();
    return s ? scopes.filter((x) => x !== "offline_access" && !s.has(x)) : [];
  }

  async get<T = any>(path: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    return this.call<T>("GET", path, undefined, headers, signal);
  }

  async call<T = any>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    const token = await this.accessToken();
    const r = await this.fetchImpl(path.startsWith("http") ? path : `${GRAPH}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (r.status === 401) { this.access = undefined; throw new NotConnected(); }
    if (!r.ok) {
      const e = await r.json().catch(() => ({})) as { error?: { message?: string } };
      if (r.status === 403) throw new Forbidden(e.error?.message ?? r.statusText);
      throw new Error(`Microsoft Graph ${r.status} : ${e.error?.message ?? r.statusText}`);
    }
    if (r.status === 202 || r.status === 204) return {} as T;
    return r.json() as Promise<T>;
  }

  async me(): Promise<string | undefined> {
    const m = await this.get<{ displayName?: string; mail?: string; userPrincipalName?: string }>("me?$select=displayName,mail,userPrincipalName");
    this.who = m.mail ?? m.userPrincipalName ?? m.displayName;
    return this.who;
  }
}

export class NotConnected extends Error {
  constructor(detail?: string) {
    super(`Microsoft 365 n'est pas connecté${detail ? ` (${detail})` : ""}. Dis à l'utilisateur de cliquer « Se connecter » sur Microsoft 365 dans Réglages → Connecteurs.`);
  }
}

/** Microsoft refuse : une permission manque (connexion faite avant l'ajout d'une fonction, ou accord d'admin requis). */
export class Forbidden extends Error {
  constructor(detail: string) {
    super(`Microsoft refuse l'accès (permission manquante : ${detail}). ${RELOGIN}`);
  }
}

export const RELOGIN = "Dis à l'utilisateur de cliquer « Se connecter » sur Microsoft 365 (Réglages → Connecteurs) pour accorder les nouvelles permissions.";

/** Permissions (« scp ») d'un jeton d'accès Microsoft. undefined si le jeton n'est pas lisible. */
export function scopesOf(token: string): Set<string> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { scp?: string };
    return typeof claims.scp === "string" ? new Set(claims.scp.split(" ")) : undefined;
  } catch {
    return undefined;
  }
}
