import { describe, expect, it, vi } from "vitest";
import type { Context } from "@floppy/core";
import type { BodyHub, InitiativePresented, LiveService } from "@floppy/contracts";
import type { Body } from "../src/model.ts";
import { createInitiatives } from "../src/initiatives.ts";
import { reduce, type BodyEvent } from "../src/body-state.ts";

function fixture(live = false) {
  const presented: InitiativePresented[] = [];
  const audit: Record<string, unknown>[] = [];
  let receive!: (event: { source: string; text: string; key?: string; importance: "normal" | "important" }) => void;
  const ctx = {
    on(_name: string, listener: typeof receive) { receive = listener; },
    audit: { write: (row: Record<string, unknown>) => audit.push(row) },
    async runHook(name: string, event: InitiativePresented) { if (name === "initiative.presented") presented.push(event); },
    timeout() {},
  } as unknown as Context;
  const send = vi.fn();
  const has = vi.fn(() => true);
  const sessions = vi.fn(() => [{ id: "voice", enabled: true }, { id: "chat", enabled: true }]);
  const hub = { has, send, sessions } as unknown as BodyHub;
  const say = vi.fn();
  const voice = { id: "voice", voice: true, text: false, muted: false, state: "idle", playing: false, awakeUntil: 0, lastTurnAt: 0, awaiting: new Set(), stream: { setSpeaking() {} }, output: { cancel() {} }, ...(live ? { live: { active: true, busy: false, awaitingApproval: false, say } } : {}) } as unknown as Body;
  const chat = { id: "chat", voice: false, text: true } as Body;
  const spoken = vi.fn();
  let seq = 0;
  // Le vrai réducteur : le corps de test prend les mêmes phases que dans le plugin.
  const dispatch = (body: Body, event: BodyEvent) => {
    const r = reduce({ muted: body.muted, awakeUntil: body.awakeUntil, ptt: !!body.ptt, turn: !!body.turn, init: !!body.init, playing: body.playing, speechOpen: !!body.speechOpen, phase: body.phase }, event, Date.now(), { freeListenMs: 8000 });
    Object.assign(body, { muted: r.flags.muted, awakeUntil: r.flags.awakeUntil, ptt: r.flags.ptt, playing: r.flags.playing, speechOpen: r.flags.speechOpen, phase: r.flags.phase, state: r.state });
    return !r.ignored;
  };
  const initiatives = createInitiatives({ ctx, hub, live: live ? {} as LiveService : undefined, bodies: new Map([[voice.id, voice], [chat.id, chat]]), nextSeq: () => ++seq, dispatch, setEmotion() {}, neutralSoon() {}, speakOut: spoken, endDuck() {} });
  return { voice, presented, spoken, say, audit, send, has, sessions, initiatives, emit(text: string, importance: "normal" | "important" = "important", key?: string) { receive({ source: "orca", text, importance, key }); } };
}

describe("présentation des initiatives", () => {
  it("une carte transmise programme l'affichage dans chaque origine sans prétendre être lue", () => {
    const f = fixture(); f.emit("Courrier terminé", "normal", "mail-1");
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.spoken).not.toHaveBeenCalled();
    expect(f.presented).toEqual([
      { origin: "voice", session: "voice", source: "orca", key: "mail-1", stage: "display-scheduled" },
      { origin: "chat", session: "chat", source: "orca", key: "mail-1", stage: "display-scheduled" },
    ]);
    expect(f.audit.at(-1)).toMatchObject({ spoken: false });
  });

  it("sans corps compatible ou après échec de transmission aucune présentation n'est déclarée", () => {
    const silent = fixture(); silent.has.mockReturnValue(false);
    silent.emit("private notification", "normal", "silent");
    expect(silent.send).not.toHaveBeenCalled();
    expect(silent.presented).toEqual([]);
    const disabled = fixture(); disabled.sessions.mockReturnValue([{ id: "voice", enabled: false }]);
    disabled.emit("private notification", "normal", "disabled");
    expect(disabled.send).not.toHaveBeenCalled();
    expect(disabled.presented).toEqual([]);
    const failed = fixture(); failed.send.mockImplementation(() => { throw new Error("private detail"); });
    failed.emit("private notification", "normal", "failed");
    expect(failed.presented).toEqual([]);
    expect(failed.audit.filter((e) => e.stage === "display_send_failed")).toHaveLength(2);
    expect(JSON.stringify(failed.audit)).not.toContain("private");
  });

  it("la file n'est pas une présentation et la programmation n'est pas une preuve d'écoute", () => {
    const f = fixture(); f.voice.muted = true;
    f.emit("Courrier terminé", "important", "mail-1");
    expect(f.presented).toEqual([]);
    expect(f.audit.at(-1)).toMatchObject({ spoken: false, stage: "queued", queueLength: 1 });
    f.voice.muted = false; f.initiatives.drain();
    expect(f.presented).toEqual([{ origin: "voice", session: "voice", source: "orca", key: "mail-1", stage: "scheduled" }]);
    expect(f.audit.at(-1)).toMatchObject({ stage: "scheduled", spoken: false });
    f.initiatives.finishInit(f.voice);
    expect(f.presented.at(-1)?.stage).toBe("completed");
  });

  it("une coupure annonce seulement interruption, jamais une fin entendue", () => {
    const f = fixture(); f.emit("Courrier terminé", "important", "mail-1");
    f.initiatives.abortInit(f.voice);
    expect(f.presented.map((e) => e.stage)).toEqual(["scheduled", "interrupted"]);
  });

  it("deux événements de même texte restent distincts, un même événement est dédupliqué", () => {
    const f = fixture(); f.emit("Même phrase", "important", "turn-1");
    f.emit("Même phrase", "important", "turn-2");
    f.emit("Même phrase", "important", "turn-2");
    f.initiatives.finishInit(f.voice);
    expect(f.spoken).toHaveBeenCalledTimes(2);
    expect(f.presented.filter((e) => e.stage === "scheduled").map((e) => e.key)).toEqual(["turn-1", "turn-2"]);
    expect(f.audit.some((e) => e.stage === "deduped")).toBe(true);
  });

  it("conserve le dédoublonnage historique par texte sans clé explicite", () => {
    const f = fixture(); f.emit("Même phrase"); f.emit("Même phrase");
    expect(f.spoken).toHaveBeenCalledTimes(1);
  });

  it("une file saturée signale l'abandon et ne présente jamais l'annonce retirée", () => {
    const f = fixture(); f.voice.muted = true;
    for (let n = 0; n < 6; n++) f.emit(`Phrase ${n}`, "important", `event-${n}`);
    expect(f.presented).toEqual([]);
    expect(f.audit.some((e) => e.stage === "queue_dropped")).toBe(true);
    f.voice.muted = false; f.initiatives.drain();
    expect(f.presented[0]?.key).toBe("event-1");
  });

  it("le mode Live utilise la même origine et déclare seulement la programmation connue", () => {
    const f = fixture(true); f.voice.muted = true;
    f.emit("Courrier terminé", "important", "mail-1");
    expect(f.presented).toEqual([]);
    f.voice.muted = false; f.initiatives.drain();
    expect(f.say).toHaveBeenCalledWith("Courrier terminé");
    expect(f.presented).toEqual([{ origin: "voice", session: "voice", source: "orca", key: "mail-1", stage: "scheduled" }]);
    expect(f.presented.some((e) => e.stage === "completed")).toBe(false);
  });
});
