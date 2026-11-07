// Initiatives : annonces venant d'autres plugins (une tâche finie, un téléchargement…). Montrées sur les corps qui
// savent afficher ; les importantes sont dites sur le corps vocal principal quand il est libre, sinon mises en file.
import type { Context } from "@floppy/core";
import type { BodyHub, LiveService } from "@floppy/contracts";
import type { BodyState, Emotion } from "@floppy/protocol";
import type { Body, Initiative } from "./model.ts";

export interface InitiativeDeps {
  ctx: Context;
  hub: BodyHub;
  live: LiveService | undefined;
  bodies: Map<string, Body>;
  freeListen(): number;
  nextSeq(): number;
  setState(b: Body, state: BodyState): void;
  setEmotion(emotion: Emotion | string, ms?: number, intensity?: number): void;
  neutralSoon(): void;
  speakOut(b: Body, id: string, text: string): void;
  endDuck(b: Body, restore: boolean): void;
}

export function createInitiatives(d: InitiativeDeps) {
  const { ctx, hub, live, bodies, setState, setEmotion, neutralSoon, speakOut, endDuck } = d;
  const queue: Initiative[] = [];
  const recent: { text: string; at: number }[] = [];
  const primary = () => [...bodies.values()].find((b) => b.voice && b.stream);
  const idle = (b: Body) => !b.muted && !b.turn && !b.init && !b.playing;

  /** Dit une phrase hors tour (réponse de la voie rapide). Une 2e phrase prend le relais de la 1re. */
  const sayDirect = (b: Body, text: string) => {
    if (b.init) b.output?.cancel();
    const id = `i${d.nextSeq()}`;
    b.init = { id, done: false };
    setState(b, "speaking");
    speakOut(b, id, text);
  };
  const speakInitiative = (b: Body, it: Initiative) => {
    const id = `i${d.nextSeq()}`;
    b.init = { id, done: false };
    recent.push({ text: it.text, at: Date.now() });
    if (recent.length > 5) recent.shift();
    setEmotion("curious");
    setState(b, "speaking");
    speakOut(b, id, it.text);
    ctx.audit.write({ kind: "initiative", source: it.source, importance: "important", spoken: true });
  };
  const finishInit = (b: Body) => {
    if (!b.init) return;
    b.init = undefined;
    b.playing = false;
    b.stream?.setSpeaking(false);
    b.awakeUntil = Date.now() + d.freeListen() * 1000; // écoute libre : on peut répondre sans le mot
    setState(b, b.muted ? "sleep" : "listening");
    ctx.timeout(() => { if (!b.turn && !b.init && b.state === "listening" && Date.now() >= b.awakeUntil) setState(b, "idle"); }, d.freeListen() * 1000 + 50);
    neutralSoon();
    drain();
  };
  const abortInit = (b: Body) => {
    if (!b.init) return;
    endDuck(b, false);
    b.output?.cancel();
    hub.send(b.id, { type: "interrupt" });
    b.init = undefined;
    b.playing = false;
    b.stream?.setSpeaking(false);
  };
  /** Dit la prochaine initiative en attente, si le corps vocal principal est libre. */
  const drain = () => {
    if (live) {
      const b = [...bodies.values()].find((b) => b.live?.active && !b.muted && !b.live.busy && !b.live.awaitingApproval);
      if (b) for (const item of queue.splice(0)) { b.live!.say(item.text); ctx.audit.write({ kind: "initiative", source: item.source, importance: "important", spoken: true }); }
      return;
    }
    const b = primary();
    if (!b || !idle(b) || !queue.length) return;
    speakInitiative(b, queue.shift()!);
  };
  // Anti-doublon : une même annonce (même clé, ou même texte) n'est pas répétée pendant 10 minutes.
  const lastSeen = new Map<string, number>();
  ctx.on("initiative", (e) => {
    const dedupe = e.key ?? e.text;
    const seen = lastSeen.get(dedupe) ?? lastSeen.get(e.text);
    if (seen && Date.now() - seen < 10 * 60_000) return;
    lastSeen.set(dedupe, Date.now());
    lastSeen.set(e.text, Date.now());
    if (lastSeen.size > 200) lastSeen.clear();
    const important = e.importance === "important";
    for (const id of bodies.keys()) {
      if (hub.has(id, "display") || hub.has(id, "text")) hub.send(id, { type: "notify", text: e.text, important });
    }
    if (!important) { ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: false }); return; }
    const b = primary();
    if (live && b?.live?.active && !b.muted && !b.live.busy && !b.live.awaitingApproval) { b.live.say(e.text); ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: true }); return; }
    if (!live && b && idle(b) && !queue.length) { speakInitiative(b, e); return; }
    // Occupé, muet ou en veille : en file (FIFO, sans doublon de clé, 5 au plus).
    if (e.key && queue.some((q) => q.key === e.key)) return;
    queue.push({ source: e.source, text: e.text, ...(e.key ? { key: e.key } : {}) });
    if (queue.length > 5) queue.shift();
    ctx.audit.write({ kind: "initiative", source: e.source, importance: e.importance, spoken: false });
  });
  return { sayDirect, finishInit, abortInit, drain, recent };
}
