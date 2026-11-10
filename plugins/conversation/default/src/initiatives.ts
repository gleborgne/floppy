// Initiatives : annonces venant d'autres plugins (une tâche finie, un téléchargement…). Montrées sur les corps qui
// savent afficher ; les importantes sont dites sur le corps vocal principal quand il est libre, sinon mises en file.
import type { Context } from "@floppy/core";
import type { BodyHub, LiveService, InitiativePresented, InitiativeDelivery } from "@floppy/contracts";
import type { Emotion } from "@floppy/protocol";
import type { BodyEvent } from "./body-state.ts";
import type { Body, Initiative } from "./model.ts";

export interface InitiativeDeps {
  ctx: Context;
  hub: BodyHub;
  live: LiveService | undefined;
  bodies: Map<string, Body>;
  nextSeq(): number;
  /** Seul point d'entrée pour changer la phase d'un corps (propriétaire : `index.ts`). */
  dispatch(b: Body, event: BodyEvent): boolean;
  setEmotion(emotion: Emotion | string, ms?: number, intensity?: number): void;
  neutralSoon(): void;
  speakOut(b: Body, id: string, text: string): void;
  endDuck(b: Body, restore: boolean): void;
}

export function createInitiatives(d: InitiativeDeps) {
  const { ctx, hub, live, bodies, dispatch, setEmotion, neutralSoon, speakOut, endDuck } = d;
  const queue: Initiative[] = [];
  const recent: { text: string; at: number; origin: string }[] = [];
  const primary = () => [...bodies.values()].find((b) => b.voice && b.stream);
  const idle = (b: Body) => !b.muted && !b.turn && !b.init && !b.playing;
  const pending = new Map<string, Initiative>();
  const delivery = (item: Initiative, stage: InitiativeDelivery["stage"]) => {
    const event: InitiativeDelivery = { source: item.source, key: item.key, stage, queueLength: queue.length };
    void ctx.runHook("initiative.delivery", event, async () => {}).catch(() => {});
  };
  const presented = (b: Body, item: Initiative, stage: InitiativePresented["stage"]) => {
    const event: InitiativePresented = { origin: b.id, session: b.id, source: item.source, key: item.key, stage };
    void ctx.runHook("initiative.presented", event, async () => {}).catch(() => {
      ctx.audit.write({ kind: "initiative", stage: "presentation_hook_failed", source: item.source, origin: b.id });
    });
  };

  /** Dit une phrase hors tour (réponse de la voie rapide). Une 2e phrase prend le relais de la 1re. */
  const sayDirect = (b: Body, text: string) => {
    if (b.init) b.output?.cancel();
    const previous = pending.get(b.id);
    if (previous) { pending.delete(b.id); presented(b, previous, "interrupted"); }
    const id = `i${d.nextSeq()}`;
    b.init = { id, done: false };
    dispatch(b, { type: "announce_started" });
    speakOut(b, id, text);
  };
  const speakInitiative = (b: Body, it: Initiative) => {
    const id = `i${d.nextSeq()}`;
    b.init = { id, done: false };
    recent.push({ text: it.text, at: Date.now(), origin: b.id });
    if (recent.length > 5) recent.shift();
    setEmotion("curious");
    dispatch(b, { type: "announce_started" });
    speakOut(b, id, it.text);
    pending.set(b.id, it);
    presented(b, it, "scheduled");
    ctx.audit.write({ kind: "initiative", source: it.source, importance: "important", spoken: false, stage: "scheduled" });
  };
  const finishInit = (b: Body) => {
    if (!b.init) return;
    const item = pending.get(b.id);
    if (item) { pending.delete(b.id); presented(b, item, "completed"); }
    b.init = undefined;
    b.stream?.setSpeaking(false);
    dispatch(b, { type: "announce_finished" }); // écoute libre : on peut répondre sans le mot
    neutralSoon();
    drain();
  };
  const abortInit = (b: Body) => {
    if (!b.init) return;
    const item = pending.get(b.id);
    if (item) { pending.delete(b.id); presented(b, item, "interrupted"); }
    endDuck(b, false);
    b.output?.cancel();
    hub.send(b.id, { type: "interrupt" });
    b.init = undefined;
    dispatch(b, { type: "announce_aborted" });
    b.stream?.setSpeaking(false);
  };
  /** Dit la prochaine initiative en attente, si le corps vocal principal est libre. */
  const drain = () => {
    if (live) {
      const b = [...bodies.values()].find((b) => b.live?.active && !b.muted && !b.live.busy && !b.live.awaitingApproval);
      if (b) { const item = queue.shift(); if (item) { b.live!.say(item.text); presented(b, item, "scheduled"); ctx.audit.write({ kind: "initiative", source: item.source, importance: "important", spoken: false, stage: "scheduled" }); } }
      return;
    }
    const b = primary();
    if (!b || !idle(b) || !queue.length) return;
    speakInitiative(b, queue.shift()!);
  };
  // Une clé explicite identifie l'événement ; sans clé, compatibilité par le texte.
  const lastSeen = new Map<string, number>();
  ctx.on("initiative", (e) => {
    const dedupe = e.key ?? e.text;
    const seen = lastSeen.get(dedupe);
    if (seen !== undefined && Date.now() - seen < 10 * 60_000) { ctx.audit.write({ kind: "initiative", source: e.source, stage: "deduped" }); delivery(e, "deduped"); return; }
    lastSeen.set(dedupe, Date.now());
    for (const [key, at] of lastSeen) if (Date.now() - at >= 10 * 60_000) lastSeen.delete(key);
    if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value!);
    const important = e.importance === "important";
    const visibleBodies = new Set(hub.sessions().filter((s) => s.enabled !== false).map((s) => s.id));
    for (const b of bodies.values()) {
      if (visibleBodies.has(b.id) && (hub.has(b.id, "display") || hub.has(b.id, "text"))) {
        try {
          hub.send(b.id, { type: "notify", text: e.text, important });
          if (!important) presented(b, e, "display-scheduled");
        } catch {
          ctx.audit.write({ kind: "initiative", source: e.source, stage: "display_send_failed", origin: b.id });
        }
      }
    }
    if (!important) { ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: false }); return; }
    const b = primary();
    if (live && b?.live?.active && !b.muted && !b.live.busy && !b.live.awaitingApproval) { b.live.say(e.text); presented(b, e, "scheduled"); ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: false, stage: "scheduled" }); return; }
    if (!live && b && idle(b) && !queue.length) { speakInitiative(b, e); return; }
    // Occupé, muet ou en veille : en file (FIFO, sans doublon de clé, 5 au plus).
    if (e.key && queue.some((q) => q.key === e.key)) return;
    queue.push({ source: e.source, text: e.text, ...(e.key ? { key: e.key } : {}) });
    if (queue.length > 5) { const dropped = queue.shift()!; ctx.audit.write({ kind: "initiative", source: dropped.source, stage: "queue_dropped" }); delivery(dropped, "dropped"); }
    delivery(e, "queued");
    ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: false, stage: "queued", queueLength: queue.length });
  });
  return { sayDirect, finishInit, abortInit, drain, recent };
}
