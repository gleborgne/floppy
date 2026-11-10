// Plugin `body-ws` : transport WebSocket pour les corps hors de l'app (corps de test, téléphone, Reachy…).
// 127.0.0.1 seulement, jeton obligatoire (?token=). Port et jeton sont écrits dans <home>/body-ws.json
// (lisible par l'utilisateur seul) pour les clients locaux comme `floppy chat`.
// Texte = JSON du protocole ; binaire entrant = audio micro float32 16 kHz ; binaire sortant = voix.
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { definePlugin, T, type ItemInfo } from "@floppy/core";
import type { BodyToKernel, BodyTransport, KernelToBody } from "@floppy/protocol";

const Config = z.object({ port: z.number().int().min(0).default(8750) });
type Config = z.infer<typeof Config>;

export function wsTransport(ws: WebSocket): BodyTransport {
  const onMsg: ((m: BodyToKernel) => void)[] = [];
  const onAudio: ((f: Float32Array) => void)[] = [];
  const onClose: (() => void)[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const b = data as Buffer;
      const copy = new Uint8Array(b.byteLength);
      copy.set(b);
      const f = new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
      for (const fn of onAudio) { try { fn(f); } catch { /* audio ignoré */ } }
      return;
    }
    // JSON.parse("null") ou un nombre ne lèvent rien mais ne sont pas des messages : on vérifie la forme.
    let m: BodyToKernel;
    try {
      const j: unknown = JSON.parse(String(data));
      if (!j || typeof j !== "object" || Array.isArray(j) || typeof (j as { type?: unknown }).type !== "string") throw new Error("forme");
      m = j as BodyToKernel;
    } catch {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", text: "message invalide" }));
      return;
    }
    // Un abonné qui lève ne doit jamais remonter jusqu'au serveur (crash du noyau).
    for (const fn of onMsg) {
      try { fn(m); } catch { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", text: "message refusé" })); }
    }
  });
  ws.on("close", () => { for (const fn of onClose) fn(); });
  return {
    send: (m: KernelToBody) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    sendAudio: (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); },
    onMessage: (fn) => { onMsg.push(fn); },
    onAudio: (fn) => { onAudio.push(fn); },
    onClose: (fn) => { onClose.push(fn); },
    close: () => ws.close(),
  };
}

export default definePlugin<Config>({
  manifest: {
    id: "body-ws",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "body", label: { fr: "Corps et affichage", en: "Bodies and display" } },
    ],
    description: "Transport WebSocket des corps (127.0.0.1 + jeton).",
    inject: ["body"],
  },
  config: Config,
  async apply(ctx, cfg) {
    const hub = ctx.get("body");
    const token = randomBytes(24).toString("hex");
    const want = Buffer.from(token);
    // Appareils : un jeton par appareil, nommé. Seule l'empreinte (sha256) est gardée ; le jeton n'est montré qu'une fois.
    const store = ctx.items.store("body-ws-devices");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    type Device = { name: string; hash: string; created: string };
    const deviceOf = (t: string): string | undefined => {
      const h = sha(t);
      return Object.entries(store.data.added).find(([, a]) => (a.values as unknown as Device).hash === h)?.[0];
    };
    const sockets = new Map<string, Set<WebSocket>>();
    const tokenOf = (url?: string) => new URL(url ?? "/", "http://x").searchParams.get("token") ?? "";
    const wss = new WebSocketServer({
      host: "127.0.0.1", port: cfg.port, maxPayload: 4 * 1024 * 1024,
      verifyClient: (info: { req: { url?: string } }) => {
        const got = Buffer.from(tokenOf(info.req.url));
        // Un appareil désactivé garde son jeton (rien n'est supprimé) mais ne peut plus se brancher.
        const dev = got.length ? deviceOf(got.toString()) : undefined;
        const ok = (got.length === want.length && timingSafeEqual(got, want)) || (!!dev && store.isEnabled(dev));
        if (!ok) ctx.audit.write({ kind: "body-ws.auth_refused" });
        return ok;
      },
    });
    await new Promise<void>((ok, ko) => { wss.once("listening", ok); wss.once("error", ko); });
    const port = (wss.address() as { port: number }).port;
    const file = join(ctx.home, "body-ws.json");
    writeFileSync(file, JSON.stringify({ port, token }), { encoding: "utf8", mode: 0o600 });
    let anon = 0;
    wss.on("connection", (ws, req) => {
      const dev = deviceOf(tokenOf(req.url));
      if (dev) {
        const set = sockets.get(dev) ?? new Set<WebSocket>();
        set.add(ws);
        sockets.set(dev, set);
        ws.on("close", () => { set.delete(ws); ctx.items.changed(); });
        ctx.items.changed();
      }
      // Identité fixée ici : id d'appareil authentifié (jeton d'appareil) ou id anonyme pour le jeton local ;
      // le hello du client ne choisit ni son id ni `managed`.
      const devName = dev ? (store.data.added[dev]?.values as unknown as Device | undefined)?.name : undefined;
      // Appareil à jeton : listé ici (« Autres appareils », gestion du jeton), donc `managed` pour que « Corps » ne le liste pas une 2e fois.
      hub.attach(wsTransport(ws), { id: dev ?? `ws-${++anon}`, ...(devName ? { name: devName } : {}), managed: !!dev });
    });
    ctx.items.declare({
      id: "ws-devices", section: "body", order: 50,
      label: { fr: "Autres appareils", en: "Other devices" },
      description: { fr: "Un jeton par appareil qui se connecte à Floppy en WebSocket (cet ordinateur seulement).", en: "One token per device connecting to Floppy over WebSocket (this computer only)." },
      addLabel: { fr: "Ajouter un appareil", en: "Add a device" },
      kinds: [{
        id: "device",
        label: { fr: "Autre appareil", en: "Other device" },
        description: { fr: "Une app qui se connecte à Floppy. Un jeton est créé, montré une seule fois.", en: "An app that connects to Floppy. A token is created and shown only once." },
        fields: [{ key: "name", label: { fr: "Nom de l'appareil", en: "Device name" }, type: "text", required: true, placeholder: { fr: "Mon téléphone", en: "My phone" } }],
      }],
      list: () => Object.entries(store.data.added).map(([id, a]): ItemInfo => {
        const d = a.values as unknown as Device;
        const enabled = store.isEnabled(id);
        const on = enabled && (sockets.get(id)?.size ?? 0) > 0;
        return {
          id, label: d.name, kind: "device", enabled, status: on ? "ok" : "off",
          statusText: !enabled ? { fr: "désactivé", en: "disabled" } : on ? { fr: "branché", en: "connected" } : { fr: "pas branché", en: "not connected" },
          detail: { fr: `jeton créé le ${d.created.slice(0, 10)}`, en: `token created ${d.created.slice(0, 10)}` },
          editable: false, removable: true, toggleable: true,
        };
      }),
      // Désactiver ≠ supprimer : le jeton reste, l'appareil est débranché et ne peut plus se brancher tant qu'il est désactivé.
      setEnabled: async (id, on) => {
        if (!store.isAdded(id)) return { ok: false, text: T("Appareil inconnu.", "Unknown device.") };
        store.setEnabled(id, on);
        const name = (store.data.added[id]!.values as unknown as Device).name;
        if (!on) { for (const w of sockets.get(id) ?? []) w.terminate(); sockets.delete(id); }
        ctx.items.changed();
        return { ok: true, text: on ? T(`${name} peut de nouveau se brancher.`, `${name} can connect again.`) : T(`${name} est débranché et ne peut plus se brancher (jeton gardé).`, `${name} is disconnected and can no longer connect (token kept).`) };
      },
      add: async (_kind, values) => {
        const name = String(values.name ?? "").trim();
        if (!name) return { ok: false, text: T("Donne un nom à l'appareil.", "Give the device a name.") };
        const t = randomBytes(24).toString("hex");
        const id = store.add("device", { name, hash: sha(t), created: new Date().toISOString() } as unknown as Record<string, unknown>, name);
        const url = `ws://127.0.0.1:${port}/?token=${t}`;
        return { ok: true, id, text: T(
          `Jeton de ${name} (montré une seule fois, copie-le maintenant) : ${t}\nAdresse : ${url}`,
          `Token for ${name} (shown only once, copy it now): ${t}\nAddress: ${url}`,
        ) };
      },
      remove: async (id) => {
        if (!store.isAdded(id)) return { ok: false, text: T("Appareil inconnu.", "Unknown device.") };
        store.remove(id);
        store.setEnabled(id, true); // plus de trace dans la liste des désactivés
        for (const w of sockets.get(id) ?? []) w.terminate();
        sockets.delete(id);
        return { ok: true, text: T("Jeton révoqué : l'appareil est déconnecté.", "Token revoked: the device is disconnected.") };
      },
    });
    ctx.effect(async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
      rmSync(file, { force: true });
    });
    ctx.log("info", `corps WebSocket : ws://127.0.0.1:${port}`);
  },
});
