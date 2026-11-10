import { describe, it, expect } from "vitest";
import { STATES } from "@floppy/protocol";
import { LISTENING_TIMER_MARGIN_MS, TRANSITIONS, canListenWithoutWake, isExpectedTransition, openListeningState, reduce, showState, type BodyEvent, type BodyFlags, type BodyPhase } from "../src/body-state.ts";

const flags = (f: Partial<BodyFlags> = {}): BodyFlags => ({ muted: false, turn: false, init: false, playing: false, awakeUntil: 0, ...f });
const NOW = 1_000_000;

describe("état montré d'après les drapeaux", () => {
  it("écouter sans mot d'activation : écoute libre ou bouton parler, jamais en veille", () => {
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW + 1 }, NOW)).toBe(true);
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW }, NOW)).toBe(true);
    expect(canListenWithoutWake({ muted: false, awakeUntil: NOW - 1 }, NOW)).toBe(false);
    expect(canListenWithoutWake({ muted: true, awakeUntil: NOW + 1000 }, NOW)).toBe(false);
    expect(canListenWithoutWake({ muted: false, ptt: true, awakeUntil: 0 }, NOW)).toBe(true);
  });
  it("l'écoute libre d'un corps muet reste « sleep »", () => {
    expect(openListeningState({ muted: true })).toBe("sleep");
    expect(openListeningState({ muted: false })).toBe("listening");
  });
});

describe("table des transitions", () => {
  it("couvre chaque état et ne cite que des états connus", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) for (const to of targets) expect(STATES).toContain(to);
  });
  it.each([
    ["sleep", "idle"], ["sleep", "listening"], ["idle", "listening"], ["listening", "thinking"], ["thinking", "speaking"],
    ["speaking", "listening"], ["thinking", "listening"], ["thinking", "idle"], ["speaking", "thinking"], ["idle", "speaking"],
  ] as const)("%s → %s est prévu", (from, to) => { expect(isExpectedTransition(from, to)).toBe(true); });
  it("rester sur place et passer en veille sont toujours permis", () => {
    for (const s of STATES) { expect(isExpectedTransition(s, s)).toBe(true); expect(isExpectedTransition(s, "sleep")).toBe(true); }
  });
  it("une transition absente de la table est signalée", () => {
    expect(isExpectedTransition("sleep", "speaking")).toBe(false);
  });
});

// ---------------------------------------------------------------- le réducteur
const OPTS = { freeListenMs: 8000 };
const run = (f: Partial<BodyFlags>, event: BodyEvent, now = NOW) => reduce(flags(f), event, now, OPTS);

describe("réducteur : un test par événement", () => {
  it("l'état montré est calculé : muet ⇒ sleep, sinon la phase", () => {
    expect(showState({ muted: true, phase: "speaking" })).toBe("sleep");
    expect(showState({ muted: false, phase: "thinking" })).toBe("thinking");
    expect(showState({ muted: false })).toBe("idle");
  });
  it("wake : sort de la veille ; avec une durée, ouvre l'écoute libre et montre listening", () => {
    const r = run({ muted: true, phase: "speaking" }, { type: "wake" });
    expect(r.flags.muted).toBe(false);
    expect(r.state).toBe("idle");
    const l = run({ muted: true }, { type: "wake", ms: 8000 });
    expect(l.state).toBe("listening");
    expect(l.flags.awakeUntil).toBe(NOW + 8000);
  });
  it("wake sur un corps éveillé ne change pas sa phase", () => {
    expect(run({ phase: "speaking" }, { type: "wake" }).state).toBe("speaking");
  });
  it("listening_started : montre listening sans toucher à la fenêtre", () => {
    const r = run({ muted: false, awakeUntil: 5 }, { type: "listening_started" });
    expect(r.state).toBe("listening");
    expect(r.flags.awakeUntil).toBe(5);
  });
  it("sleep : muet, fenêtre fermée, état sleep", () => {
    const r = run({ awakeUntil: NOW + 5000, phase: "listening", speechOpen: true }, { type: "sleep" });
    expect(r.state).toBe("sleep");
    expect(r.flags).toMatchObject({ muted: true, awakeUntil: 0, speechOpen: false });
  });
  it("mute : comme sleep ; unmute : repos", () => {
    expect(run({ awakeUntil: NOW + 5000 }, { type: "mute" }).state).toBe("sleep");
    const r = run({ muted: true }, { type: "unmute" });
    expect(r.state).toBe("idle");
    expect(r.flags.muted).toBe(false);
  });
  it("ptt_on : réveille, écoute pour 60 s ; ptt_off : écoute libre ensuite ; ptt_dropped : rien d'autre", () => {
    const on = run({ muted: true }, { type: "ptt_on" });
    expect(on).toMatchObject({ state: "listening", flags: { ptt: true, muted: false, awakeUntil: NOW + 60_000 } });
    const off = run({ ptt: true, phase: "listening" }, { type: "ptt_off" });
    expect(off.flags).toMatchObject({ ptt: false, awakeUntil: NOW + 8000 });
    expect(off.state).toBe("listening");
    expect(run({ ptt: true, awakeUntil: 9 }, { type: "ptt_dropped" }).flags).toMatchObject({ ptt: false, awakeUntil: 9 });
  });
  it("open_listening : fenêtre, listening, minuteur à armer ; sur un corps muet l'état reste sleep", () => {
    const r = run({ phase: "speaking" }, { type: "open_listening" });
    expect(r).toMatchObject({ state: "listening", listenFor: 8050, flags: { awakeUntil: NOW + 8000 } });
    expect(run({ muted: true }, { type: "open_listening" }).state).toBe("sleep");
  });
  it("close_listening : ferme la fenêtre et le bouton parler, retour au repos", () => {
    const r = run({ phase: "listening", awakeUntil: NOW + 5000, ptt: true, speechOpen: true }, { type: "close_listening" });
    expect(r.ignored).toBeUndefined();
    expect(r).toMatchObject({ state: "idle", flags: { awakeUntil: 0, ptt: false, speechOpen: false } });
  });
  it("listening_expired : retour au repos si la fenêtre est finie et rien ne se passe", () => {
    expect(run({ phase: "listening", awakeUntil: NOW - 1 }, { type: "listening_expired" }).state).toBe("idle");
    expect(run({ phase: "listening", awakeUntil: NOW + 1000 }, { type: "listening_expired" }).state).toBe("listening");
    expect(run({ phase: "listening", awakeUntil: NOW - 1, turn: true }, { type: "listening_expired" }).state).toBe("listening");
    expect(run({ phase: "listening", awakeUntil: NOW - 1, init: true }, { type: "listening_expired" }).state).toBe("listening");
  });
  it("speech_detected : listening dans la fenêtre hors tour, et la parole est retenue ouverte", () => {
    expect(run({ awakeUntil: NOW + 1 }, { type: "speech_detected" })).toMatchObject({ state: "listening", flags: { speechOpen: true } });
    expect(run({ awakeUntil: NOW - 1 }, { type: "speech_detected" })).toMatchObject({ state: "idle", flags: { speechOpen: false } });
    expect(run({ awakeUntil: NOW + 1, turn: true, phase: "thinking" }, { type: "speech_detected" }).state).toBe("thinking");
    expect(run({ muted: true, awakeUntil: NOW + 1 }, { type: "speech_detected" })).toMatchObject({ state: "sleep", flags: { speechOpen: false } });
  });
  it("transcript : ferme la parole ouverte ; une phrase commencée dans la fenêtre l'allonge d'une seconde", () => {
    const r = run({ speechOpen: true, awakeUntil: NOW - 500 }, { type: "transcript" });
    expect(r.flags).toMatchObject({ speechOpen: false, awakeUntil: NOW + 1000 });
    expect(run({ speechOpen: false, awakeUntil: NOW - 500 }, { type: "transcript" }).flags.awakeUntil).toBe(NOW - 500);
    expect(run({ speechOpen: true, muted: true, awakeUntil: NOW - 500 }, { type: "transcript" }).flags.awakeUntil).toBe(NOW - 500);
  });
  it("speech_dropped : la parole ouverte ne compte plus, sans allonger la fenêtre", () => {
    expect(run({ speechOpen: true, awakeUntil: NOW - 500 }, { type: "speech_dropped" }).flags).toMatchObject({ speechOpen: false, awakeUntil: NOW - 500 });
  });
  it("turn_started : thinking", () => { expect(run({}, { type: "turn_started" }).state).toBe("thinking"); });
  it("speech_started : le corps joue et parle", () => {
    expect(run({ phase: "thinking", turn: true }, { type: "speech_started" })).toMatchObject({ state: "speaking", flags: { playing: true } });
  });
  it("turn_finished : écoute libre après la voix (minuteur à armer), repos après le texte", () => {
    expect(run({ phase: "speaking", turn: false }, { type: "turn_finished", voice: true })).toMatchObject({ state: "listening", listenFor: 8050 });
    const t = run({ phase: "thinking" }, { type: "turn_finished", voice: false });
    expect(t.state).toBe("idle");
    expect(t.listenFor).toBeUndefined();
  });
  it("turn_interrupted et announce_aborted : plus rien ne joue, retour au repos", () => {
    for (const type of ["turn_interrupted", "announce_aborted"] as const) {
      expect(run({ playing: true, phase: "speaking" }, { type })).toMatchObject({ state: "idle", flags: { playing: false } });
    }
  });
  it("announce_started : speaking ; announce_finished : écoute libre", () => {
    expect(run({}, { type: "announce_started" }).state).toBe("speaking");
    expect(run({ playing: true, phase: "speaking" }, { type: "announce_finished" })).toMatchObject({ state: "listening", listenFor: 8050, flags: { playing: false } });
  });
  it("quick_started / quick_finished : réflexion puis repos", () => {
    expect(run({}, { type: "quick_started" }).state).toBe("thinking");
    expect(run({ phase: "thinking" }, { type: "quick_finished" }).state).toBe("idle");
  });
  it("approval_barge_in : le son s'arrête, le corps écoute, le tour attend l'outil", () => {
    expect(run({ phase: "speaking", playing: true, turn: true }, { type: "approval_barge_in" })).toMatchObject({ state: "listening", flags: { playing: false } });
  });
  it("playback : change seulement la lecture", () => {
    expect(run({ phase: "speaking" }, { type: "playback", on: true })).toMatchObject({ state: "speaking", flags: { playing: true } });
    expect(run({ phase: "speaking", playing: true }, { type: "playback", on: false })).toMatchObject({ state: "speaking", flags: { playing: false } });
  });
  it("live_state : la phase du mode Live ; listening rouvre la fenêtre sauf si muet", () => {
    expect(run({}, { type: "live_state", state: "speaking" }).state).toBe("speaking");
    expect(run({}, { type: "live_state", state: "listening" }).flags.awakeUntil).toBe(NOW + 8000);
    expect(run({ muted: true }, { type: "live_state", state: "listening" })).toMatchObject({ state: "sleep", flags: { awakeUntil: 0 } });
  });
});

describe("réducteur : l'écoute qui se ferme", () => {
  it("wake avec une durée, ptt_off et listening_started (avec durée) rendent le minuteur de retour au repos", () => {
    expect(run({ muted: true }, { type: "wake", ms: 8000 }).listenFor).toBe(8050);
    expect(run({ ptt: true, phase: "listening" }, { type: "ptt_off" }).listenFor).toBe(8050);
    const l = run({ awakeUntil: 5 }, { type: "listening_started", ms: 10_000 });
    expect(l).toMatchObject({ state: "listening", listenFor: 10_050, flags: { awakeUntil: 5 } });
    expect(run({ awakeUntil: 5 }, { type: "listening_started" }).listenFor).toBeUndefined();
    expect(run({ muted: true }, { type: "listening_started", ms: 10_000 }).listenFor).toBeUndefined();
    expect(run({ phase: "idle" }, { type: "wake" }).listenFor).toBeUndefined();
  });
  it("une activation sans phrase : le minuteur ramène au repos", () => {
    const l = run({ awakeUntil: 5 }, { type: "listening_started", ms: 10_000 });
    expect(reduce(l.flags, { type: "listening_expired" }, NOW + 10_050, OPTS).state).toBe("idle");
  });
  it("listening_expired ne ferme rien tant que le bouton parler est tenu, qu'une parole est ouverte ou qu'un son joue", () => {
    for (const f of [{ ptt: true }, { speechOpen: true }, { playing: true }] as const) {
      expect(run({ phase: "listening", awakeUntil: NOW - 1, ...f }, { type: "listening_expired" }).state).toBe("listening");
    }
  });
  it("la fin d'une lecture pendant l'écoute rearme le minuteur (sinon l'écoute resterait ouverte)", () => {
    const l = run({ phase: "listening", awakeUntil: NOW - 1, playing: true }, { type: "playback", on: false });
    expect(l).toMatchObject({ state: "listening", listenFor: 50 });
    expect(reduce(l.flags, { type: "listening_expired" }, NOW + 50, OPTS).state).toBe("idle");
  });
  it("un vieux minuteur qui sonne après une fenêtre prolongée ne fait rien", () => {
    const l = run({ phase: "listening", ptt: true }, { type: "ptt_off" });
    expect(reduce(l.flags, { type: "listening_expired" }, NOW + 100, OPTS).state).toBe("listening");
    expect(reduce(l.flags, { type: "listening_expired" }, NOW + 8050, OPTS).state).toBe("idle");
  });
  it("ptt_on ne rend aucun minuteur (60 s, tant que la touche est tenue)", () => {
    expect(run({}, { type: "ptt_on" }).listenFor).toBeUndefined();
  });
  it("une parole commencée dans la fenêtre puis abandonnée après sa fin : le minuteur est rearmé", () => {
    const r = run({ phase: "listening", speechOpen: true, awakeUntil: NOW - 500 }, { type: "speech_dropped" });
    expect(r.listenFor).toBe(LISTENING_TIMER_MARGIN_MS);
    expect(reduce(r.flags, { type: "listening_expired" }, NOW + 50, OPTS).state).toBe("idle");
  });
  it("live_state : le mode Live ferme lui-même son écoute (« idle »), le réducteur n'arme rien", () => {
    expect(run({}, { type: "live_state", state: "listening" }).listenFor).toBeUndefined();
    expect(run({ phase: "listening" }, { type: "live_state", state: "idle" }).state).toBe("idle");
  });
});

describe("réducteur : après une coupure", () => {
  it("turn_interrupted et announce_aborted sans suite : retour au repos", () => {
    for (const type of ["turn_interrupted", "announce_aborted"] as const) {
      for (const phase of ["speaking", "thinking"] as const) {
        const r = run({ playing: true, phase }, { type });
        expect(r).toMatchObject({ state: "idle", flags: { playing: false } });
        expect(r.listenFor).toBeUndefined();
      }
    }
  });
  it("l'écoute libre encore ouverte continue, avec son minuteur ; le bouton parler tenu aussi, sans minuteur", () => {
    expect(run({ phase: "speaking", awakeUntil: NOW + 3000 }, { type: "turn_interrupted" })).toMatchObject({ state: "listening", listenFor: 3050 });
    expect(run({ phase: "speaking", ptt: true }, { type: "announce_aborted" })).toMatchObject({ state: "listening" });
    expect(run({ phase: "speaking", ptt: true }, { type: "announce_aborted" }).listenFor).toBeUndefined();
  });
  it("un corps muet reste « sleep » ; un tour ou une annonce encore là garde sa phase", () => {
    expect(run({ muted: true, phase: "speaking", awakeUntil: NOW + 3000 }, { type: "turn_interrupted" }).state).toBe("sleep");
    expect(run({ phase: "speaking", init: true }, { type: "turn_interrupted" }).state).toBe("speaking");
    expect(run({ phase: "speaking", turn: true }, { type: "announce_aborted" }).state).toBe("speaking");
  });
  it("coupure puis nouvelle demande : thinking (passage par idle, prévu par la table)", () => {
    const cut = run({ playing: true, phase: "speaking" }, { type: "turn_interrupted" });
    expect(isExpectedTransition("speaking", cut.state)).toBe(true);
    expect(reduce(cut.flags, { type: "turn_started" }, NOW, OPTS).state).toBe("thinking");
  });
});

describe("réducteur : cas de bord", () => {
  it("phrase commencée pendant l'écoute libre et finie après : elle est couverte", () => {
    let f = run({ awakeUntil: NOW + 100 }, { type: "speech_detected" }).flags;
    f = reduce(f, { type: "transcript" }, NOW + 3000, OPTS).flags;
    expect(f.awakeUntil).toBe(NOW + 4000);
    expect(f.speechOpen).toBe(false);
  });
  it("muet pendant un tour : l'état est sleep, le réveil rend le repos et non la phase d'avant", () => {
    let r = run({ turn: true, phase: "thinking" }, { type: "mute" });
    expect(r.state).toBe("sleep");
    r = reduce(r.flags, { type: "turn_interrupted" }, NOW, OPTS);
    r = reduce(r.flags, { type: "unmute" }, NOW, OPTS);
    expect(r.state).toBe("idle");
  });
  it("une fin de tour vocale sur un corps muet laisse sleep", () => {
    expect(run({ muted: true, phase: "speaking" }, { type: "turn_finished", voice: true }).state).toBe("sleep");
  });
  it("bouton parler pendant la veille : réveille et écoute", () => {
    const r = run({ muted: true, awakeUntil: 0 }, { type: "ptt_on" });
    expect(r.state).toBe("listening");
    expect(canListenWithoutWake(r.flags, NOW)).toBe(true);
  });
  it("annonce pendant l'écoute : speaking, puis l'écoute libre reprend à la fin", () => {
    let r = run({ phase: "listening", awakeUntil: NOW + 5000 }, { type: "announce_started" });
    expect(r.state).toBe("speaking");
    r = reduce({ ...r.flags, playing: true }, { type: "announce_finished" }, NOW + 4000, OPTS);
    expect(r).toMatchObject({ state: "listening", flags: { awakeUntil: NOW + 12_000, playing: false } });
  });
  it("« arrêter l'écoute » est ignoré pendant une réponse (tour, annonce ou lecture)", () => {
    for (const f of [{ turn: true }, { init: true }, { playing: true }] as const) {
      const r = run({ phase: "listening", awakeUntil: NOW + 5000, ...f }, { type: "close_listening" });
      expect(r.ignored).toBe(true);
      expect(r.state).toBe("listening");
      expect(r.flags.awakeUntil).toBe(NOW + 5000);
    }
    expect(run({ phase: "thinking" }, { type: "close_listening" }).ignored).toBe(true);
    expect(run({ muted: true, phase: "listening" }, { type: "close_listening" }).ignored).toBe(true);
  });
});

describe("réducteur : toute transition produite est dans la table", () => {
  const phases: BodyPhase[] = ["idle", "listening", "thinking", "speaking"];
  const bools = [false, true];
  const events: BodyEvent[] = [
    { type: "wake" }, { type: "wake", ms: 8000 }, { type: "listening_started" }, { type: "listening_started", ms: 10_000 }, { type: "sleep" }, { type: "mute" }, { type: "unmute" },
    { type: "ptt_on" }, { type: "ptt_off" }, { type: "ptt_dropped" }, { type: "open_listening" }, { type: "close_listening" },
    { type: "listening_expired" }, { type: "speech_detected" }, { type: "transcript" }, { type: "speech_dropped" }, { type: "turn_started" },
    { type: "speech_started" }, { type: "turn_finished", voice: true }, { type: "turn_finished", voice: false }, { type: "turn_interrupted" },
    { type: "announce_started" }, { type: "announce_finished" }, { type: "announce_aborted" }, { type: "quick_started" }, { type: "quick_finished" },
    { type: "approval_barge_in" }, { type: "playback", on: true }, { type: "playback", on: false },
    ...(["idle", "listening", "thinking", "speaking", "sleep"] as const).map((state) => ({ type: "live_state", state }) as BodyEvent),
  ];
  it("sur toutes les combinaisons de drapeaux", () => {
    let n = 0;
    for (const muted of bools) for (const turn of bools) for (const init of bools) for (const playing of bools) for (const ptt of bools) for (const speechOpen of bools)
      for (const phase of phases) for (const awakeUntil of [0, NOW - 1, NOW + 1000]) for (const event of events) {
        const f: BodyFlags = { muted, turn, init, playing, ptt, speechOpen, phase, awakeUntil };
        const r = reduce(f, event, NOW, OPTS);
        const from = showState(f);
        expect(isExpectedTransition(from, r.state), `${from} → ${r.state} par ${JSON.stringify(event)} sur ${JSON.stringify(f)}`).toBe(true);
        expect(r.state).toBe(showState(r.flags));
        n++;
      }
    expect(n).toBeGreaterThan(10_000);
  });
});
