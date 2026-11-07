// Plugin `body-hub` : service `body`. Plusieurs corps branchés en même temps (avatar, Reachy, Telegram, test…).
// - Chaque corps est une session : id, capacités, outils corps. Les transports (MessagePort, WebSocket,
//   adaptateurs) appellent attach().
// - Demandes d'accord : envoyées aux corps qui ont la capacité `approval` (et autorisés par la config) ;
//   la première réponse gagne, les autres reçoivent approval.closed.
// - Outils corps : ajoutés au registre du noyau ; un appel va au corps d'origine du tour s'il a l'outil,
//   sinon au premier corps qui l'a.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { definePlugin, T, type ItemInfo, type Text, type ToolDef } from "@floppy/core";
import type { AttachOpts, BodyHub, BodySessionInfo, HubEvent } from "@floppy/contracts";

// Types du service body : définis dans @floppy/core (contrat du noyau).
export type { AttachOpts, BodyHub, BodySessionInfo, HubEvent } from "@floppy/contracts";
import {
  CAPABILITIES, PROTOCOL_VERSION, type BodyToKernel, type BodyTransport, type Capability, type KernelToBody, type BodyToolDecl,
} from "@floppy/protocol";

// Messages venant d'un corps : validés avant toute utilisation (un client mal élevé ne doit pas faire tomber le noyau).
const ToolDecl = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(""),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  level: z.enum(["read", "write", "send", "delete", "physical"]),
});
const Hello = z.object({
  type: z.literal("hello"),
  name: z.string().min(1).max(80),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
  tools: z.array(ToolDecl).max(100).optional(),
});
const Incoming = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("ptt"), on: z.boolean() }),
  z.object({ type: z.literal("dictate"), on: z.boolean() }),
  z.object({ type: z.literal("mute"), on: z.boolean() }),
  z.object({ type: z.literal("approval.response"), id: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal("tool.result"), callId: z.string(), ok: z.boolean(), text: z.string() }),
  z.object({ type: z.literal("playback"), playing: z.boolean() }),
  z.object({ type: z.literal("document.open"), id: z.string().max(200) }),
  z.object({ type: z.literal("document.delete"), id: z.string().max(200), current: z.string().max(200).optional() }),
]);

const Config = z.object({
  /** Corps autorisés à répondre aux accords (ids). Vide = tous ceux qui ont la capacité `approval`. */
  approvalsFrom: z.array(z.string()).default([]),
  toolTimeout_s: z.number().default(20),
});
type Config = z.infer<typeof Config>;

interface Session extends BodySessionInfo {
  /** Branché par un plugin qui le liste lui-même (Reachy…) : pas de 2e ligne dans « Corps ». */
  managed?: boolean;
  transport: BodyTransport;
  decl: BodyToolDecl[];
}

export default definePlugin<Config>({
  manifest: {
    id: "body-hub",
    version: "0.1.0",
    licence: "MIT",
    sections: [
      { id: "corps", order: 50, merge: true, label: { fr: "Corps et affichage", en: "Bodies and display" }, description: { fr: "Un corps, c'est là où Floppy t'entend et te répond. Plusieurs corps peuvent marcher en même temps.", en: "A body is where Floppy hears and answers you. Several bodies can run at the same time." } },
    ],
    description: "Service body : plusieurs corps à la fois, routage des accords et des outils corps.",
    provides: ["body"],
    permissions: { approvals: "respond" },
  },
  config: Config,
  apply(ctx, cfg) {
    const sessions = new Map<string, Session>();
    const listeners = new Set<(ev: HubEvent) => void>();
    const emit = (ev: HubEvent) => { for (const fn of [...listeners]) { try { fn(ev); } catch (e) { ctx.log("error", `abonné du hub : ${String(e)}`); } } };
    // Outils corps : un nom = une entrée du registre, partagée par tous les corps qui l'ont.
    const bodyTools = new Map<string, { owners: Set<string>; unregister: () => void }>();
    const pendingCalls = new Map<string, { bodyId: string; resolve: (r: { ok: boolean; text: Text }) => void; timer: NodeJS.Timeout }>();

    // Corps désactivés : gardés par id (fixé par le transport) dans <home>/items/bodies.json. Le hub les ignore (pas de tours, de réponses, d'accords).
    const store = ctx.items.store("bodies");
    const isOn = (s: Session) => store.isEnabled(s.id);
    const canApprove = (s: Session) => isOn(s) && s.capabilities.includes("approval") && (!cfg.approvalsFrom.length || cfg.approvalsFrom.includes(s.id));

    const registerTool = (s: Session, d: BodyToolDecl) => {
      const cur = bodyTools.get(d.name);
      if (cur) { cur.owners.add(s.id); return; }
      const def: ToolDef = {
        name: d.name, description: d.description, inputSchema: d.inputSchema, level: d.level,
        handler: async (args, meta) => {
          const entry = bodyTools.get(d.name);
          const live = [...(entry?.owners ?? [])].filter((id) => { const o = sessions.get(id); return o && isOn(o); });
          const target = meta.origin && live.includes(meta.origin) ? meta.origin : live[0];
          const body = target ? sessions.get(target) : undefined;
          if (!body || !isOn(body)) return { status: "failed", text: T("Aucun corps branché ne sait faire cela.", "No connected body can do that.") };
          const callId = randomUUID();
          const r = await new Promise<{ ok: boolean; text: Text }>((resolve) => {
            const timer = setTimeout(() => { pendingCalls.delete(callId); resolve({ ok: false, text: T("Le corps n'a pas répondu.", "The body did not answer.") }); }, cfg.toolTimeout_s * 1000);
            pendingCalls.set(callId, { bodyId: body.id, resolve, timer });
            body.transport.send({ type: "tool.call", callId, name: d.name, args });
          });
          return { status: r.ok ? "done" : "failed", text: r.text };
        },
      };
      // Le registre refuse un nom déjà pris (outil MCP du même nom) : on le signale sans casser le corps.
      try {
        const unregister = ctx.tools.register([def]);
        bodyTools.set(d.name, { owners: new Set([s.id]), unregister });
      } catch (e) {
        ctx.log("warn", `outil corps ${d.name} ignoré : ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const dropOwner = (bodyId: string) => {
      for (const [name, t] of bodyTools) {
        t.owners.delete(bodyId);
        if (!t.owners.size) { t.unregister(); bodyTools.delete(name); }
      }
    };

    ctx.on("approval.request", (r) => {
      const msg: KernelToBody = { type: "approval.request", id: r.id, tool: r.tool, summary: r.summary, level: r.level, ttl_s: r.ttl_s };
      for (const s of sessions.values()) if (canApprove(s)) s.transport.send(msg);
    });
    ctx.on("approval.closed", (c) => {
      for (const s of sessions.values()) if (isOn(s) && s.capabilities.includes("approval")) s.transport.send({ type: "approval.closed", id: c.id, ok: c.ok });
    });

    const hub: BodyHub = {
      attach(transport, opts = {}) {
        let session: Session | undefined;
        const refuse = (text: string) => { try { transport.send({ type: "error", text }); } catch { /* transport fermé */ } };
        const handle = (raw: BodyToKernel) => {
          if (!session) {
            const h = Hello.safeParse(raw);
            if (!h.success) { refuse(raw && (raw as { type?: unknown }).type === "hello" ? "hello invalide" : "premier message attendu : hello"); return; }
            const msg = h.data;
            // Identité : donnée par le transport. Sans id de confiance, un id aléatoire (le hello ne choisit rien).
            const base = opts.id ?? `corps-${randomUUID().slice(0, 8)}`;
            let id = base;
            for (let i = 2; sessions.has(id); i++) id = `${base}-${i}`;
            const name = opts.name ?? msg.name;
            const decl: BodyToolDecl[] = msg.tools ?? [];
            session = { id, name, capabilities: msg.capabilities, tools: decl.map((t) => t.name), transport, decl, managed: opts.managed === true };
            sessions.set(id, session);
            for (const d of session.decl) registerTool(session, d);
            transport.send({ type: "welcome", protocol: PROTOCOL_VERSION, assistant: { name: ctx.assistant.name, language: ctx.assistant.language } });
            // Demandes d'accord déjà en cours (corps branché pendant une attente).
            if (canApprove(session)) for (const r of ctx.approvals.pending()) {
              transport.send({ type: "approval.request", id: r.id, tool: r.tool, summary: r.summary, level: r.level, ttl_s: Math.max(1, Math.round((r.expiresAt - Date.now()) / 1000)) });
            }
            ctx.log("info", `corps branché : ${id} (${name}) [${msg.capabilities.join(", ")}]`);
            ctx.audit.write({ kind: "body.join", body: id, name, capabilities: msg.capabilities });
            emit({ type: "join", body: { id, name, capabilities: msg.capabilities, tools: session.tools } });
            ctx.items.changed();
            return;
          }
          const s = session;
          const p0 = Incoming.safeParse(raw);
          if (!p0.success) { refuse("message invalide"); return; }
          const msg = p0.data as BodyToKernel;
          if (!isOn(s) && msg.type !== "tool.result") return; // corps désactivé : on l'ignore
          if (msg.type === "approval.response") {
            if (!canApprove(s)) { ctx.log("warn", `${s.id} n'a pas le droit de répondre aux accords`); return; }
            ctx.approvals.respond(msg.id, msg.ok, s.id);
            return;
          }
          if (msg.type === "tool.result") {
            // Seul le corps à qui l'appel a été envoyé peut y répondre.
            const p = pendingCalls.get(msg.callId);
            if (p && p.bodyId === s.id) { clearTimeout(p.timer); pendingCalls.delete(msg.callId); p.resolve({ ok: msg.ok, text: msg.text }); }
            else if (p) ctx.log("warn", `${s.id} a répondu à l'appel d'un autre corps`);
            return;
          }
          emit({ type: "message", bodyId: s.id, msg });
        };
        transport.onMessage((raw) => {
          try { handle(raw); } catch (e) { ctx.log("error", `message de corps : ${e instanceof Error ? e.message : String(e)}`); refuse("message refusé"); }
        });
        transport.onAudio((frame) => { if (session && isOn(session)) emit({ type: "audio", bodyId: session.id, frame }); });
        transport.onClose(() => {
          if (!session) return;
          sessions.delete(session.id);
          dropOwner(session.id);
          // Appels d'outils en attente sur ce corps : échec tout de suite (pas d'attente du délai).
          for (const [callId, p] of [...pendingCalls]) {
            if (p.bodyId !== session.id) continue;
            clearTimeout(p.timer); pendingCalls.delete(callId);
            p.resolve({ ok: false, text: T("Le corps s'est débranché.", "The body disconnected.") });
          }
          ctx.log("info", `corps débranché : ${session.id}`);
          ctx.audit.write({ kind: "body.leave", body: session.id });
          emit({ type: "leave", bodyId: session.id });
          ctx.items.changed();
        });
      },
      sessions: () => [...sessions.values()].map((s) => ({ id: s.id, name: s.name, capabilities: s.capabilities, tools: s.tools, enabled: isOn(s) })),
      has: (id, cap) => sessions.get(id)?.capabilities.includes(cap) ?? false,
      send: (id, msg) => { const s = sessions.get(id); if (s && isOn(s)) s.transport.send(msg); },
      sendAudio: (id, data) => { const s = sessions.get(id); if (s && isOn(s)) s.transport.sendAudio(data); },
      broadcast: (msg, cap) => { for (const s of sessions.values()) if (isOn(s) && (!cap || s.capabilities.includes(cap))) s.transport.send(msg); },
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
    ctx.effect(() => { for (const s of sessions.values()) s.transport.close(); sessions.clear(); });

    // Fenêtre des réglages : corps branchés (et corps désactivés gardés par nom).
    const CAP_LABEL: Record<string, Text> = {
      voice: T("voix", "voice"), text: T("texte", "text"), voice_note: T("messages vocaux", "voice notes"), display: T("écran", "screen"),
      emotion: T("émotions", "emotions"), gesture: T("gestes", "gestures"), approval: T("accord", "approval"), panel: T("fenêtre de résultats", "results window"),
    };
    const OFF = "nom:";
    ctx.items.declare({
      id: "bodies", section: "corps", order: 10,
      label: { fr: "Corps", en: "Bodies" },
      description: { fr: "Là où Floppy t'entend et te répond. Désactivé : Floppy l'ignore, sans le supprimer.", en: "Where Floppy hears and answers you. Disabled: Floppy ignores it, nothing is deleted." },
      list: () => {
        const items: ItemInfo[] = [...sessions.values()].filter((s) => !s.managed).map((s) => {
          const on = isOn(s);
          return {
            id: s.id, label: s.name, detail: { fr: "branché", en: "connected" }, enabled: on, status: on ? "ok" : "off",
            statusText: on ? { fr: "branché", en: "connected" } : { fr: "branché, ignoré", en: "connected, ignored" },
            tags: s.capabilities.map((c) => CAP_LABEL[c] ?? c),
            editable: false, removable: false, toggleable: true, aliases: [s.id],
          };
        });
        const live = new Set([...sessions.values()].map((s) => s.id));
        for (const name of store.data.disabled) {
          if (live.has(name)) continue;
          items.push({ id: OFF + name, label: name, detail: { fr: "pas branché", en: "not connected" }, enabled: false, status: "off", editable: false, removable: false, toggleable: true });
        }
        return items;
      },
      setEnabled: async (id, on) => {
        const s = sessions.get(id);
        const key = s ? s.id : id.startsWith(OFF) ? id.slice(OFF.length) : undefined;
        if (!key) return { ok: false, text: T("Corps inconnu.", "Unknown body.") };
        store.setEnabled(key, on);
        const name = s ? s.name : key;
        return { ok: true, text: on ? T(`${name} est de nouveau écouté.`, `${name} is listened to again.`) : T(`${name} est ignoré (gardé dans la liste).`, `${name} is ignored (kept in the list).`) };
      },
    });
    ctx.provide("body", hub);
  },
});
