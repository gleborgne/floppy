// Côté noyau d'un plugin tiers isolé : un PluginDef « mandataire » qui fait tourner le vrai code dans un processus Node
// à part (sandbox-child.ts), avec le modèle de permissions de Node. Le noyau ne change pas : il voit un plugin normal.
//
// Tout ce que le processus envoie est vérifié ici (il est le plugin, donc non fiable) :
// - outils : nom, niveau (read/write/send/delete), schéma ; l'accord est demandé par le noyau comme pour tout outil ;
// - réglages : clé préfixée par l'id du plugin ; jamais lus à la voix si « cli » (règle du noyau) ;
// - bus : n'émet que `initiative` (source forcée) ; n'écoute que des événements sans données privées ;
// - réseau : fetch fait ici, seulement vers les hôtes de permissions.net, redirections vérifiées une à une ;
// - journal d'audit : `kind` préfixé par « plugin. » (il ne peut pas imiter une ligne du noyau).
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findExe, hostAllowed, T, TextError, type Context, type PluginDef, type SettingDef, type Text, type ToolDef, type ToolResult } from "@floppy/core";
import { hashDir } from "./check.ts";
import { manifestMismatch, type PluginPackage } from "./format.ts";

export const CHILD = join(dirname(fileURLToPath(import.meta.url)), "sandbox-child.ts");

export interface SandboxOptions {
  dir: string;
  pkg: PluginPackage;
  /** Empreinte acceptée à l'installation : le plugin ne démarre pas si ses fichiers ont changé depuis. */
  expectHash?: string;
  /** Programme Node (défaut : celui qui tourne, ou `node` du PATH dans l'app de bureau). */
  node?: string;
  /** Mode debug : débogueur (--inspect) ; Node ne le permet pas avec --permission, l'isolation des fichiers est alors levée. */
  inspect?: boolean;
  /** Délais (ms) : chargement + apply, appel d'outil. */
  timeouts?: { start?: number; call?: number };
  /** Fonction fetch du noyau (tests). */
  fetch?: typeof fetch;
}

const LEVELS = new Set(["read", "write", "send", "delete"]);
const RISKS = new Set(["free", "ask", "cli"]);
const TYPES = new Set(["enum", "number", "boolean", "text"]);
const STATUSES = new Set(["done", "unverified", "failed", "refused"]);
const LISTEN = new Set(["plugin.state", "service.changed"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_BODY = 5_000_000;

/** Programme Node pour le processus isolé. */
export function nodeExe(): string {
  if (process.env.FLOPPY_NODE) return process.env.FLOPPY_NODE;
  if (!process.versions.electron) return process.execPath;
  const n = findExe("node");
  if (!n) throw new TextError(T("Node.js est introuvable : il faut Node 24 dans le PATH pour les plugins tiers", "Node.js was not found: third-party plugins need Node 24 in the PATH"));
  return n;
}

const isText = (x: unknown): x is Text => (typeof x === "string" && x.length <= 4000) || (!!x && typeof x === "object" && typeof (x as { fr?: unknown }).fr === "string");
const str = (x: unknown, max = 2000): string => String(x ?? "").slice(0, max);

/** Préfixe obligatoire des clés de réglage d'un plugin tiers. */
export const settingPrefix = (id: string): string => id.replaceAll("-", "_") + "_";

export function sandboxedPlugin(o: SandboxOptions): PluginDef<any> {
  const { dir, pkg } = o;
  return {
    manifest: {
      id: pkg.id, version: pkg.version, licence: pkg.licence,
      ...(pkg.description ? { description: pkg.description } : {}),
      ...(pkg.permissions ? { permissions: pkg.permissions } : {}),
      ...(pkg.sections ? { sections: pkg.sections } : {}),
      runtime: "out-of-process",
    },
    async apply(ctx: Context, cfg: unknown) {
      if (o.expectHash && hashDir(dir) !== o.expectHash) {
        throw new TextError(T("ses fichiers ont changé depuis l'installation : réinstalle-le pour le faire relire", "its files changed since it was installed: reinstall it to have it reviewed again"));
      }
      const start = o.timeouts?.start ?? 15_000;
      const callTimeout = o.timeouts?.call ?? 120_000;
      // Chemins réels (noms courts de Windows, liens) : le modèle de permissions de Node compare des chemins exacts.
      const real = realpathSync.native(dir);
      const child_ = realpathSync.native(CHILD);
      const args = [
        ...(o.inspect ? ["--inspect"] : ["--permission", `--allow-fs-read=${real}`, `--allow-fs-read=${child_}`]),
        "--disable-warning=ExperimentalWarning", child_, real,
      ];
      const child: ChildProcess = spawn(o.node ?? nodeExe(), args, {
        // Dossier courant hors du plugin : Windows ne bloque pas sa suppression (désinstallation) pendant qu'il tourne.
        cwd: tmpdir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json",
        // Aucune variable d'environnement (clés, jetons) : seulement ce qu'il faut à Windows pour démarrer.
        env: process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {},
      });
      let stopping = false;
      child.stdout?.on("data", (d) => ctx.log("info", `[sortie] ${str(d, 1000).trimEnd()}`));
      child.stderr?.on("data", (d) => ctx.log("warn", `[erreurs] ${str(d, 1000).trimEnd()}`));

      let seq = 0;
      const pending = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void; timer: NodeJS.Timeout }>();
      const send = (m: Record<string, unknown>): void => { if (child.connected) child.send(m); };
      const request = (m: Record<string, unknown>, ms: number): Promise<any> => new Promise((ok, ko) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); ko(new TextError(T("le plugin ne répond pas (délai dépassé)", "the plugin does not answer (timed out)"))); }, ms);
        pending.set(id, { ok, ko, timer });
        send({ ...m, id });
      });
      const reply = (id: unknown, ok: boolean, value?: unknown): void => send({ t: "reply", id, ok, ...(ok ? { value } : { error: String(value) }) });

      const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
      child.on("exit", (code) => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.ko(new TextError(T("le processus du plugin s'est arrêté", "the plugin process stopped"))); }
        pending.clear();
        if (!stopping && ctx.alive) ctx.fail(T(`le processus du plugin s'est arrêté (code ${code})`, `the plugin process stopped (code ${code})`));
      });
      child.on("error", (e) => ctx.log("error", `processus : ${e.message}`));
      ctx.effect(async () => {
        stopping = true;
        if (child.exitCode === null) {
          await Promise.race([request({ t: "stop" }, 2000).catch(() => {}), exited]);
          child.disconnect?.();
          await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
          if (child.exitCode === null) { child.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]); }
        }
      });

      // --- outils, réglages, écoutes
      const toolOffs = new Map<number, () => void>();
      const values = new Map<string, unknown>();
      const prefix = settingPrefix(pkg.id);
      const net = pkg.permissions?.net ?? [];

      const toTool = (d: Record<string, unknown>): ToolDef => {
        const name = str(d.name, 64);
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`nom d'outil invalide : ${name}`);
        if (!LEVELS.has(String(d.level))) throw new Error(`niveau d'outil invalide : ${String(d.level)}`);
        const schema = d.inputSchema;
        if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") throw new Error(`inputSchema de ${name} : type "object" attendu`);
        return {
          name, description: str(d.description, 2000), inputSchema: schema as Record<string, unknown>, level: d.level as ToolDef["level"],
          summary: (a) => {
            const j = JSON.stringify(a);
            const s = j.length > 160 ? j.slice(0, 157) + "…" : j;
            return T(`Plugin tiers « ${pkg.id} » : ${name} ${s}`, `Third-party plugin "${pkg.id}": ${name} ${s}`);
          },
          handler: async (a, meta): Promise<ToolResult> => {
            const id = seq + 1;
            const onAbort = () => send({ t: "abort", call: id });
            meta.signal?.addEventListener("abort", onAbort, { once: true });
            try {
              const r = await request({ t: "call", name, args: a, ...(meta.caller ? { caller: meta.caller } : {}), ...(meta.origin ? { origin: meta.origin } : {}) }, callTimeout);
              const status = STATUSES.has(r?.status) ? r.status : "failed";
              return { status, text: isText(r?.text) ? r.text : str(r?.text), ...(r?.raw !== undefined ? { raw: r.raw } : {}) };
            } finally { meta.signal?.removeEventListener("abort", onAbort); }
          },
        };
      };

      const toSetting = (d: Record<string, unknown>): SettingDef => {
        const key = str(d.key, 80);
        if (!key.startsWith(prefix) || !/^[a-z0-9_]+$/.test(key)) throw new Error(`clé de réglage « ${key} » : doit commencer par « ${prefix} »`);
        if (!TYPES.has(String(d.type)) || !RISKS.has(String(d.risk))) throw new Error(`réglage ${key} : type ou risque invalide`);
        if (!isText(d.label) || !isText(d.description)) throw new Error(`réglage ${key} : libellé ou description manquant`);
        values.set(key, d.value);
        const options = Array.isArray(d.options)
          ? (d.options as Record<string, unknown>[]).filter((x) => x && typeof x.value === "string" && isText(x.label))
            .map((x) => ({ value: String(x.value), label: x.label as Text, ...(Array.isArray(x.aliases) ? { aliases: (x.aliases as unknown[]).map((a) => str(a, 60)) } : {}) }))
          : undefined;
        return {
          key, label: d.label as Text, description: d.description as Text, type: d.type as SettingDef["type"],
          section: str(d.section || "plugins", 60), risk: d.risk as SettingDef["risk"],
          ...(isText(d.group) ? { group: d.group } : {}),
          ...(options ? { options } : {}),
          ...(typeof d.min === "number" ? { min: d.min } : {}), ...(typeof d.max === "number" ? { max: d.max } : {}),
          ...(typeof d.maxLength === "number" ? { maxLength: d.maxLength } : {}),
          get: () => values.get(key),
          set: async (v) => { await request({ t: "set", key, value: v }, callTimeout); },
        };
      };

      const doFetch = async (m: Record<string, any>): Promise<unknown> => {
        let url = new URL(String(m.url));
        const method = String(m.method ?? "GET").toUpperCase();
        let body = typeof m.body === "string" ? Buffer.from(m.body, "base64") : undefined;
        const headers = (m.headers && typeof m.headers === "object" ? m.headers : {}) as Record<string, string>;
        for (let hop = 0; hop < 6; hop++) {
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`protocole refusé : ${url.protocol}`);
          if (!hostAllowed(net, url.hostname)) throw new Error(`hôte non déclaré dans permissions.net : ${url.hostname}`);
          ctx.audit.write({ kind: "plugin.net", plugin: pkg.id, method, host: url.hostname });
          const r = await (o.fetch ?? fetch)(url, { method, headers, ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(30_000) });
          const loc = r.headers.get("location");
          if (r.status >= 300 && r.status < 400 && loc) {
            url = new URL(loc, url);
            if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) body = undefined;
            continue;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > MAX_BODY) throw new Error("réponse trop grosse");
          const h: Record<string, string> = {};
          r.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
          return { status: r.status, statusText: r.statusText, headers: h, body: buf.toString("base64"), url: url.href };
        }
        throw new Error("trop de redirections");
      };

      child.on("message", (raw: unknown) => {
        const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
        try {
          switch (m.t) {
            case "reply": {
              const p = pending.get(m.id);
              if (!p) return;
              pending.delete(m.id);
              clearTimeout(p.timer);
              m.ok ? p.ok(m.value) : p.ko(new Error(str(m.error)));
              return;
            }
            case "tools": {
              const defs = (Array.isArray(m.defs) ? m.defs : []).map(toTool);
              toolOffs.set(Number(m.reg), ctx.tools.register(defs));
              return;
            }
            case "untools": toolOffs.get(Number(m.reg))?.(); toolOffs.delete(Number(m.reg)); return;
            case "settings": ctx.settings.declare((Array.isArray(m.defs) ? m.defs : []).map(toSetting)); return;
            case "values": for (const [k, v] of Object.entries(m.values ?? {})) if (values.has(k)) values.set(k, v); return;
            case "log": ctx.log(LOG_LEVELS.has(m.level) ? m.level : "info", str(m.msg), m.data && typeof m.data === "object" ? m.data : undefined); return;
            case "audit": ctx.audit.write({ ...(m.rec && typeof m.rec === "object" ? m.rec : {}), kind: `plugin.${str(m.rec?.kind, 60)}`, plugin: pkg.id }); return;
            case "emit": {
              if (m.event !== "initiative") throw new Error(`événement refusé : ${str(m.event, 60)}`);
              const p = m.payload ?? {};
              ctx.emit("initiative", { source: pkg.id, text: str(p.text, 1000), importance: p.importance === "important" ? "important" : "normal", ...(p.key ? { key: `${pkg.id}:${str(p.key, 100)}` } : {}) } as never);
              return;
            }
            case "on": {
              if (!LISTEN.has(m.event)) throw new Error(`écoute refusée : ${str(m.event, 60)}`);
              ctx.on(m.event, (payload: unknown) => send({ t: "event", event: m.event, payload }));
              return;
            }
            case "fail": ctx.fail(isText(m.reason) ? m.reason : str(m.reason)); return;
            case "fetch": doFetch(m).then((v) => reply(m.id, true, v), (e: unknown) => reply(m.id, false, e instanceof Error ? e.message : String(e))); return;
          }
        } catch (e) {
          ctx.log("warn", `message refusé (${str(m.t, 30)}) : ${e instanceof Error ? e.message : String(e)}`);
          if (m.id !== undefined && m.t === "fetch") reply(m.id, false, e instanceof Error ? e.message : String(e));
        }
      });

      // --- démarrage : bonjour, manifeste du code (comparé au fichier JSON), apply
      await Promise.race([
        new Promise<void>((ok) => child.once("message", () => ok())),
        exited.then(() => { throw new TextError(T("le processus du plugin n'a pas démarré", "the plugin process did not start")); }),
        new Promise((_, ko) => setTimeout(() => ko(new TextError(T("le processus du plugin ne démarre pas", "the plugin process does not start"))), start)),
      ]);
      let manifest: Record<string, unknown>;
      try { manifest = await request({ t: "load" }, start); } catch (e) {
        throw new TextError(T(`chargement : ${(e as Error).message}`, `loading: ${(e as Error).message}`));
      }
      const bad = manifestMismatch(pkg, manifest ?? {});
      if (bad) throw new TextError(bad);
      try {
        await request({ t: "apply", id: ctx.id, plugin: ctx.plugin, assistantName: ctx.assistant.name, saved: ctx.settings.savedEntries(prefix), config: cfg ?? {} }, start);
      } catch (e) {
        throw new TextError(T(`démarrage : ${(e as Error).message}`, `start: ${(e as Error).message}`));
      }
    },
  };
}
