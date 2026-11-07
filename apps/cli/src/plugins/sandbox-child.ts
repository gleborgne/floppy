// Processus isolé d'un plugin tiers. Lancé par sandbox.ts :
//   node --permission --allow-fs-read=<dossier du plugin> --allow-fs-read=<ce fichier> sandbox-child.ts <dossier>
// - --permission : pas d'écriture de fichier, pas de lecture hors du plugin, pas de programme, pas de module natif.
// - Hook de résolution : le code du plugin n'importe que ses propres fichiers (aucun module de Node ni paquet).
// - Réseau : fetch passe par le noyau, qui vérifie l'hôte (permissions.net) ; WebSocket et EventSource sont retirés.
// Tout ce que ce processus envoie est traité par le noyau comme venant du plugin (non fiable) : ce fichier n'est
// qu'une commodité, la vraie frontière est le processus.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { BusEvents, PluginContext, SettingDef, ToolDef, ToolResult, UserPlugin } from "../../../../packages/sdk/floppy-plugin.d.ts";

type Msg = { t: string; [k: string]: any };

const dir = process.argv[2] ?? "";
const base = pathToFileURL(dir.replace(/[\\/]+$/, "") + "/").href;
const send = process.send!.bind(process) as (m: Msg) => boolean;

registerHooks({
  resolve(spec, context, next) {
    const r = next(spec, context);
    if (context.parentURL?.startsWith(base) && !r.url.startsWith(base)) throw new Error(`import refusé : ${spec}`);
    return r;
  },
});

// Portes de sortie retirées avant de charger le plugin.
const deny = (name: string) => () => { throw new Error(`${name} n'est pas disponible pour un plugin tiers`); };
for (const k of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen", "kill"]) {
  try { Object.defineProperty(process, k, { value: deny(`process.${k}`), configurable: false, writable: false }); } catch { /* déjà figé */ }
}
// Variables d'environnement : aucune (Node ajoute les siennes, comme le canal de messages).
for (const k of Object.keys(process.env)) delete process.env[k];
for (const k of ["WebSocket", "EventSource"]) {
  try { Object.defineProperty(globalThis, k, { get: deny(k), configurable: false }); } catch { /* absent */ }
}

// --- requêtes vers le noyau
let seq = 0;
const pending = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void }>();
function request(m: Msg): Promise<any> {
  const id = ++seq;
  return new Promise((ok, ko) => { pending.set(id, { ok, ko }); send({ ...m, id }); });
}
const reply = (id: unknown, ok: boolean, value?: unknown): void => { send({ t: "reply", id, ok, ...(ok ? { value } : { error: String(value) }) }); };
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- fetch : fait par le noyau
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
Object.defineProperty(globalThis, "fetch", {
  configurable: false, writable: false,
  value: async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? req?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    let body: string | undefined;
    const b = init.body;
    if (b != null) {
      if (typeof b === "string") body = Buffer.from(b).toString("base64");
      else if (b instanceof URLSearchParams) { body = Buffer.from(b.toString()).toString("base64"); headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8"; }
      else if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) body = Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).toString("base64");
      else throw new TypeError("fetch : corps pris en charge = texte, URLSearchParams ou octets");
    } else if (req && req.body) body = Buffer.from(await req.arrayBuffer()).toString("base64");
    const r = await request({ t: "fetch", url, method, headers, ...(body !== undefined ? { body } : {}) });
    const res = new Response(NULL_BODY.has(r.status) ? null : Buffer.from(r.body ?? "", "base64"), { status: r.status, statusText: r.statusText ?? "", headers: r.headers ?? {} });
    Object.defineProperty(res, "url", { value: r.url ?? url });
    return res;
  },
});

// --- état du plugin
let alive = false;
const effects: (() => void | Promise<void>)[] = [];
const tools = new Map<string, ToolDef>();
const settings = new Map<string, SettingDef>();
const listeners = new Map<string, ((p: any) => void)[]>();
const aborts = new Map<unknown, AbortController>();
let saved: Record<string, unknown> = {};
let regSeq = 0;

/** Valeurs courantes des réglages, renvoyées au noyau (sa fenêtre les lit sans attendre). */
function pushValues(): void {
  const values: Record<string, unknown> = {};
  for (const [k, d] of settings) { try { values[k] = d.get(); } catch { /* réglage cassé : ignoré */ } }
  if (settings.size) send({ t: "values", values });
}

const NO_SERVICE = "un plugin tiers n'a pas accès aux services de Floppy (plugin personnel seulement)";
const noService = (): never => { throw new Error(NO_SERVICE); };

function makeContext(init: Msg): PluginContext {
  return {
    id: String(init.id),
    plugin: String(init.plugin),
    assistant: { name: String(init.assistantName ?? "Floppy") },
    audit: { write: (rec) => { send({ t: "audit", rec }); } },
    tools: {
      register(defs: ToolDef[]) {
        const reg = ++regSeq;
        for (const d of defs) tools.set(d.name, d);
        send({ t: "tools", reg, defs: defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, level: d.level })) });
        let done = false;
        const off = (): void => {
          if (done) return;
          done = true;
          for (const d of defs) if (tools.get(d.name) === d) tools.delete(d.name);
          send({ t: "untools", reg });
        };
        effects.push(off);
        return off;
      },
    },
    settings: {
      declare(defs: SettingDef[]) {
        const out = defs.map((d) => {
          settings.set(d.key, d);
          const { get, set, riskFor, ...data } = d;
          let value: unknown;
          try { value = get(); } catch { value = undefined; }
          return { ...data, value };
        });
        send({ t: "settings", defs: out });
      },
      saved: <T>(key: string) => saved[key] as T | undefined,
    },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn as (p: any) => void);
      listeners.set(event, list);
      if (list.length === 1) send({ t: "on", event });
    },
    emit<K extends keyof BusEvents & string>(event: K, payload: BusEvents[K]) { send({ t: "emit", event, payload }); },
    effect(dispose) {
      effects.push(dispose);
      let done = false;
      return async () => { if (done) return; done = true; const i = effects.indexOf(dispose); if (i >= 0) effects.splice(i, 1); await dispose(); };
    },
    interval(fn, ms) { const h = setInterval(() => { if (alive) fn(); }, ms); effects.push(() => clearInterval(h)); },
    timeout(fn, ms) { const h = setTimeout(() => { if (alive) fn(); }, ms); effects.push(() => clearTimeout(h)); },
    log(level, msg, data) { send({ t: "log", level, msg: String(msg), ...(data ? { data } : {}) }); },
    get alive() { return alive; },
    fail(reason) { alive = false; send({ t: "fail", reason }); },
    // Un plugin tiers n'a pas les services de Floppy (plugin personnel seulement) : erreur claire, aucune liste.
    get: noService,
    maybe: () => undefined,
    offers: () => [],
    borrowItem: () => Promise.reject(new Error(NO_SERVICE)),
  };
}

async function stop(): Promise<void> {
  alive = false;
  for (const d of effects.splice(0).reverse()) { try { await d(); } catch { /* on continue le nettoyage */ } }
}

let plugin: UserPlugin<any> | undefined;

process.on("message", (raw: unknown) => {
  const m = raw as Msg;
  void (async () => {
    switch (m.t) {
      case "reply": {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.ok ? p.ok(m.value) : p.ko(new Error(String(m.error)));
        return;
      }
      case "load": {
        try {
          const mod = await import(base + "index.ts");
          plugin = mod.default as UserPlugin<any>;
          if (!plugin || typeof plugin !== "object" || typeof plugin.apply !== "function" || !plugin.manifest) throw new Error("export par défaut invalide : { manifest, apply } attendu");
          reply(m.id, true, JSON.parse(JSON.stringify(plugin.manifest)));
        } catch (e) { reply(m.id, false, errText(e)); }
        return;
      }
      case "apply": {
        try {
          saved = (m.saved ?? {}) as Record<string, unknown>;
          const cfg = plugin!.config ? plugin!.config.parse(m.config ?? {}) : (m.config ?? {});
          alive = true;
          await plugin!.apply(makeContext(m), cfg);
          reply(m.id, true);
        } catch (e) { alive = false; reply(m.id, false, errText(e)); }
        return;
      }
      case "call": {
        const t = tools.get(String(m.name));
        if (!t) return reply(m.id, false, `outil inconnu : ${String(m.name)}`);
        const ac = new AbortController();
        aborts.set(m.id, ac);
        try {
          const r: ToolResult = await t.handler((m.args ?? {}) as Record<string, unknown>, { ...(m.caller ? { caller: m.caller } : {}), ...(m.origin ? { origin: m.origin } : {}), signal: ac.signal });
          pushValues(); // avant la réponse : le noyau a les nouvelles valeurs quand l'appel se termine
          reply(m.id, true, r);
        } catch (e) { pushValues(); reply(m.id, false, errText(e)); } finally { aborts.delete(m.id); }
        return;
      }
      case "abort": aborts.get(m.call)?.abort(); return;
      case "set": {
        const d = settings.get(String(m.key));
        if (!d) return reply(m.id, false, `réglage inconnu : ${String(m.key)}`);
        try { await d.set(m.value); pushValues(); reply(m.id, true); } catch (e) { pushValues(); reply(m.id, false, errText(e)); }
        return;
      }
      case "event": for (const fn of listeners.get(String(m.event)) ?? []) { try { fn(m.payload); } catch { /* un abonné ne casse pas les autres */ } } return;
      case "stop": await stop(); reply(m.id, true); setImmediate(() => process.exit(0)); return;
    }
  })();
});

process.on("disconnect", () => { void stop().finally(() => process.exit(0)); });
send({ t: "hello" });
