import WebSocket from "ws";
import { T, TextError, tr, type Text } from "./i18n.ts";

export interface JsonSocket {
  send(value: unknown): void;
  close(request?: unknown, terminalType?: string): Promise<void>;
}

/** Transport JSON générique. Les erreurs ne recopient jamais une URL portant une clé. */
export function connectJsonSocket(opts: {
  url: string; headers?: Record<string, string>; start: unknown; signal: AbortSignal;
  ready: (event: Record<string, any>) => boolean;
  /** La politique du protocole reste dans l'adaptateur. */
  on: (event: Record<string, any>) => void | { close: string };
  /** Fermeture après l'ouverture. `reason` : en français (journaux) ; `text` : la même raison en français et en anglais. */
  closed: (reason: string, text: Text) => void;
}): Promise<JsonSocket> {
  opts.signal.throwIfAborted();
  const credentials = [...new URL(opts.url).searchParams.values(), ...Object.values(opts.headers ?? {}).map(v => v.replace(/^Bearer\s+/i, ""))].filter(Boolean);
  const safeReason = (raw: string) => {
    let text = raw;
    for (const secret of credentials) text = text.split(secret).join("[masqué]");
    return text.replace(/https?:\/\/\S+|wss?:\/\/\S+/gi, "[adresse masquée]").replace(/[\r\n\t]/g, " ").slice(0, 400);
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url, { headers: opts.headers, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15_000 });
    let ready = false;
    let failed = false;
    let closing: Promise<void> | undefined;
    const fail = (reason: Text) => { if (failed) return; failed = true; if (!ready) reject(new TextError(reason)); else { try { opts.closed(tr(reason, "fr"), reason); } catch { /* une erreur du consommateur ne doit pas casser le transport */ } } };
    const abort = () => { fail(T("Connexion annulée", "Connection cancelled")); ws.terminate(); };
    opts.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { fail(T("Le fournisseur n'a pas ouvert la session dans le délai prévu", "The provider did not open the session in time")); ws.terminate(); }, 15_000);
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) throw new TextError(T("Connexion fournisseur fermée", "Provider connection closed"));
      if (ws.bufferedAmount > 2 * 1024 * 1024) throw new TextError(T("Connexion audio trop lente", "Audio connection too slow"));
      ws.send(JSON.stringify(value));
    };
    const socket: JsonSocket = {
      send,
      close(request, terminalType) {
        if (closing) return closing;
        closing = new Promise<void>((done, ko) => {
          if (ws.readyState === WebSocket.CLOSED) { done(); return; }
          let finalized = !terminalType;
          const timeout = setTimeout(() => { ws.terminate(); }, terminalType ? 15_000 : 2000);
          const observe = (raw: WebSocket.RawData) => {
            try { if (JSON.parse(raw.toString()).type === terminalType) { finalized = true; ws.close(); } } catch { /* transport invalide traité par le lecteur */ }
          };
          ws.on("message", observe);
          ws.once("close", () => {
            clearTimeout(timeout); ws.off("message", observe);
            if (finalized) done(); else ko(new TextError(T("Session fermée sans confirmation finale du fournisseur", "Session closed without final confirmation from the provider")));
          });
          if (request && ws.readyState === WebSocket.OPEN) send(request);
          if (!terminalType) ws.close();
        });
        return closing;
      },
    };
    ws.on("open", () => { try { send(opts.start); } catch { fail(T("Impossible d'initialiser la session", "Could not start the session")); ws.terminate(); } });
    ws.on("message", (raw) => {
      let event: Record<string, any>;
      try {
        event = JSON.parse(raw.toString()) as Record<string, any>;
      } catch { fail(T("JSON fournisseur invalide", "Invalid JSON from the provider")); ws.close(); return; }
      try {
        if (!ready && opts.ready(event)) {
          ready = true; clearTimeout(timer); opts.signal.removeEventListener("abort", abort); resolve(socket);
        }
        const action = opts.on(event);
        if (action) { fail(action.close); ws.close(); }
      } catch { fail(T("Erreur locale de traitement du flux audio", "Local error while processing the audio stream")); ws.close(); }
    });
    ws.on("error", () => { fail(T("Connexion au fournisseur impossible", "Could not connect to the provider")); ws.terminate(); });
    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timer); opts.signal.removeEventListener("abort", abort);
      const detail = safeReason(reason?.toString() ?? "");
      fail(T(`Connexion fournisseur fermée${code ? ` (${code})` : ""}${detail ? ` : ${detail}` : ""}`, `Provider connection closed${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`));
    });
  });
}
