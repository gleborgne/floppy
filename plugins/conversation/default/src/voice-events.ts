// Événements du flux voix d'un corps : parole détectée, phrase reconnue (mot d'activation, écho de Floppy,
// accord, voie rapide, Live), coupure de parole, audio de la voix à jouer, fin d'une phrase dite.
import { T, errorText, type Context, type Text } from "@floppy/core";
import type { BodyHub, LiveService, TurnMode, VoiceEvent } from "@floppy/contracts";
import type { BodyState, Cue, Emotion } from "@floppy/protocol";
import { isSleepCommand, stripWakeWord, matchQuickSetting, isBackchannel, hasWakeWord } from "./text.ts";
import { isEcho } from "./echo.ts";
import { DUCK_MAX_MS, DUCK_WAIT_TRANSCRIPT_MS, PARAGRAPH_PAUSE_MS, silenceLike, type Body, type Turn } from "./model.ts";

export interface VoiceDeps {
  ctx: Context;
  hub: BodyHub;
  lang: "fr" | "en";
  shown(t: Text): string;
  live: LiveService | undefined;
  liveUnavailable: boolean;
  wake: string[];
  freeListen(): number;
  bodies: Map<string, Body>;
  setState(b: Body, state: BodyState): void;
  setEmotion(emotion: Emotion | string, ms?: number, intensity?: number, timing?: { body: string; id: string }, opts?: { mood?: boolean }): void;
  cue(c: Cue): void;
  maybeFinish(b: Body, t: Turn): void;
  mayEcho(b: Body): boolean;
  endDuck(b: Body, restore: boolean): void;
  duckFor(b: Body, ms: number): void;
  userBargeIn(b: Body): void;
  interrupt(b: Body, why: string): void;
  finishInit(b: Body): void;
  runTurn(b: Body, text: string, mode: TurnMode, tEnd: number): Promise<void>;
  answerApproval(b: Body, text: string): boolean;
  onUtterance(b: Body, raw: string, kind: "voice" | "text" | "ptt", tEnd: number, onAccepted?: () => void): void;
  quickSetting(b: Body, q: { key: string; value: string; label: string; slow: boolean }, mode: TurnMode, said: string): Promise<void>;
}

export function voiceHandler(d: VoiceDeps): (b: Body, ev: VoiceEvent) => void {
  return (b, ev) => {
    const { ctx, hub, lang, shown, live, liveUnavailable, wake, bodies, setState, setEmotion, cue, maybeFinish, mayEcho, endDuck, duckFor, userBargeIn, interrupt, finishInit, runTurn, answerApproval, onUtterance, quickSetting } = d;
    const freeListen = d.freeListen();
        switch (ev.type) {
          case "vad":
            if (ev.state === "speech" && !b.turn && !b.muted && Date.now() < b.awakeUntil) setState(b, "listening");
            if (b.duck) duckFor(b, ev.state === "speech" ? DUCK_MAX_MS : DUCK_WAIT_TRANSCRIPT_MS);
            // La phrase arrive après la fin de la parole + le silence + la transcription : on retient
            // qu'elle a commencé dans la fenêtre, sinon une phrase de 3 s dite à la fin est jetée.
            if (ev.state === "speech") { b.speechAt = Date.now(); b.speechOpen = !b.muted && Date.now() < b.awakeUntil; }
            // Pause après au moins une demi-seconde de parole, pendant qu'il écoute : petit hochement (« je t'entends »).
            else if (b.speechAt && Date.now() - b.speechAt > 500 && !b.muted && b.state === "listening" && !b.playing) { b.speechAt = undefined; cue("nod"); }
            break;
          case "dictation": {
            const edit = ev.final ? b.dictation?.final(ev.seg, ev.text) : b.dictation?.partial(ev.seg, ev.text);
            if (edit) hub.send(b.id, { type: "dictation", ...edit });
            break;
          }
          case "merge":
            if (!b.live?.active && b.turn && !b.turn.spoke) interrupt(b, "phrase reprise");
            break;
          case "transcript": {
            // Le STT possède une horloge commençant à l'ouverture de son flux.
            if (b.voiceOffset) ev = { ...ev, ...(ev.start_sample === undefined ? {} : { start_sample: ev.start_sample + b.voiceOffset }), ...(ev.end_sample === undefined ? {} : { end_sample: ev.end_sample + b.voiceOffset }) };
            // Un « mhm » ou un mot halluciné par le STT ne doit pas jeter l'explication.
            // Les accords, le bouton et une adresse explicite restent de vraies réponses.
            if (!b.live?.active && !b.ptt && !b.awaiting.size && (b.playing || b.duck)
              && !hasWakeWord(ev.text, wake) && !(b.wakeActivation && Date.now() <= b.wakeActivation.expires)
              && isBackchannel(ev.text)) {
              ctx.audit.write({ kind: "transcript.backchannel", body: b.id, chars: ev.text.length, ducked: !!b.duck });
              b.speechOpen = false;
              endDuck(b, true);
              break;
            }
            // Écho de la voix de Floppy : ni une demande, ni une coupure. La voix reprend son volume.
            if (!b.live?.active && !b.ptt && mayEcho(b) && isEcho(ev.text, (b.spoken ?? []).map((x) => x.text))) {
              ctx.audit.write({ kind: "transcript.echo", body: b.id, chars: ev.text.length, ducked: !!b.duck });
              endDuck(b, true);
              break;
            }
            // Parole de l'utilisateur pendant que la voix était baissée : il coupe vraiment la parole.
            if (b.duck) userBargeIn(b);
            if (answerApproval(b, ev.text)) break;
            b.wakeStream?.pushTranscript?.({ text: ev.text, startSample: ev.start_sample, endSample: ev.end_sample });
            const activation = b.wakeActivation;
            const activated = !b.live?.active && !!activation && Date.now() <= activation.expires && (activation.endSample === undefined || (ev.end_sample !== undefined && ev.end_sample >= activation.endSample));
            const startedOpen = !!b.speechOpen;
            b.speechOpen = false;
            if (startedOpen && !b.muted && Date.now() > b.awakeUntil) b.awakeUntil = Date.now() + 1000; // la fenêtre couvre cette phrase
            if (!b.live?.active && !b.ptt && (b.muted || Date.now() > b.awakeUntil) && !activated) {
              // Trace sans le texte (parole non adressée à Floppy) : assez pour voir qu'une phrase a été jetée.
              ctx.audit.write({ kind: "transcript.ignored", body: b.id, why: b.muted ? "veille" : "pas de mot d'activation", chars: ev.text.length, state: b.state, late_ms: b.muted ? undefined : Date.now() - b.awakeUntil });
              break;
            }
            if (activation && (activated || b.live?.active || b.ptt || Date.now() > activation.expires)) b.wakeActivation = undefined;
            if (activated && activation) {
              b.wakeActivation = undefined;
              b.muted = false;
              if (!live && !liveUnavailable) {
                const request = stripWakeWord(ev.text, [activation.word, ...wake]);
                if (!request) { b.awakeUntil = Date.now() + freeListen * 1000; setState(b, "listening"); break; }
                const acceptedTranscript = ev;
                onUtterance(b, request, "ptt", performance.now() - ev.stt_ms - (ev.silence_ms ?? 0), () => {
                  ctx.audit.write({ kind: "transcript", body: b.id, text: acceptedTranscript.text, stt_ms: acceptedTranscript.stt_ms, silence_ms: acceptedTranscript.silence_ms, audio_s: acceptedTranscript.audio_s, merged: acceptedTranscript.merged });
                });
                break;
              }
            }
            if (liveUnavailable) { if (activated || b.ptt || (!b.muted && Date.now() < b.awakeUntil)) hub.send(b.id, { type: "error", text: shown(T("Le moteur Live choisi est indisponible. Vérifie-le, ou repasse en mode Séparé dans les réglages.", "The chosen Live engine is unavailable. Check it, or switch back to Separate mode in the settings.")) }); break; }
            if (live && !b.live) break; // initialisation de l'écoute locale encore en cours
            if (b.live) {
              if (b.live.active) { if (!b.playing || b.live.awaitingApproval) b.live.localTranscript(ev.text); break; }
              if (isSleepCommand(ev.text, wake)) { b.muted = true; b.history?.clear(); setState(b, "sleep"); break; }
              if (b.muted && !b.ptt && !activated) break;
              if (!b.ptt && !activated && Date.now() > b.awakeUntil) break;
              if (b.playing) break;
              b.muted = false;
              const other = [...bodies.values()].find((x) => x !== b && x.live?.active);
              if (other) { hub.send(b.id, { type: "error", text: shown(T("Une conversation Live est déjà ouverte sur un autre corps.", "A Live conversation is already open on another body.")) }); break; }
              const quick = matchQuickSetting(ev.text, wake, ctx.settings.list(), lang);
              if (quick) { void quickSetting(b, quick, "text", ev.text); break; }
              void (async () => {
                const command = await ctx.runHook("conversation.command", { text: stripWakeWord(ev.text, wake), origin: b.id }, async () => undefined);
                if (!ctx.alive || b.muted) return;
                if (command && ctx.tools.list().some(tool => tool.name === command.name)) { await runTurn(b, ev.text, "text", performance.now()); return; }
                await b.live!.start(ev.start_sample, ev.end_sample, ev.text);
              })().catch((e) => hub.send(b.id, { type: "error", text: shown(errorText(e)) }));
              break;
            }
            // Audit : seulement ce qui est retenu (ni parole ignorée sans mot d'activation, ni parole en veille).
            const transcript = ev;
            onUtterance(b, ev.text, activated ? "ptt" : "voice", performance.now() - ev.stt_ms - (ev.silence_ms ?? 0), () => {
              ctx.audit.write({ kind: "transcript", body: b.id, text: transcript.text, stt_ms: transcript.stt_ms, silence_ms: transcript.silence_ms, audio_s: transcript.audio_s, merged: transcript.merged });
            });
            break;
          }
          case "barge_in":
            if (b.live?.active) { b.live.bargeIn(); break; }
            if (b.awaiting.size && b.turn) {
              // L'utilisateur répond à la demande d'accord : on coupe le son, pas le tour (il attend l'outil).
              b.output?.cancel();
              hub.send(b.id, { type: "interrupt" });
              b.turn.pending.clear();
              b.playing = false;
              b.stream?.setSpeaking(false);
              setState(b, "listening");
            } else if (b.ptt) userBargeIn(b); // bouton parler : coupure tout de suite
            else if (b.init || b.turn?.spoke || b.playing) {
              // Voix entendue pendant que Floppy parle : l'utilisateur, ou l'écho de Floppy dans le micro ?
              // Le bureau suspend la lecture sans perdre les mots ; le texte reconnu tranche (voir « transcript »).
              if (!b.duck) {
                b.duck = { timer: setTimeout(() => {}, 0) };
                duckFor(b, DUCK_MAX_MS);
                hub.send(b.id, { type: "duck", on: true });
                ctx.audit.write({ kind: "barge_in.duck", body: b.id, turn: b.turn?.n, init: !!b.init });
              }
            } else ctx.audit.write({ kind: "barge_in.ignored", body: b.id, state: b.state, turn: !!b.turn });
            break;
          case "audio": {
            const t = b.turn;
            if (!(b.init?.id === ev.id || (t && !t.abort.signal.aborted && t.pending.has(ev.id)))) break;
            if (b.init?.id === ev.id) {
              if (b.state !== "speaking" || !b.playing) { setState(b, "speaking"); b.stream?.setSpeaking(true); }
              b.playing = true;
            } else if (t && !t.abort.signal.aborted) {
              if (!t.spoke) { t.spoke = true; t.marks.first_audio ??= Math.round(performance.now() - t.t0); }
              const c = t.cues.get(ev.id);
              if (!b.playing || b.state !== "speaking") { setState(b, "speaking"); b.stream?.setSpeaking(true); }
              b.playing = true;
              if (t.pauses?.delete(ev.id)) hub.sendAudio(b.id, silenceLike(ev.data, PARAGRAPH_PAUSE_MS));
              if (c) { t.cues.delete(ev.id); setEmotion(c.emotion, undefined, c.intensity, { body: b.id, id: ev.id }, c.settling ? { mood: false } : undefined); }
              const gesture = t.gestures?.get(ev.id);
              if (gesture) {
                t.gestures!.delete(ev.id);
                if (hub.has(b.id, "speech_timing")) hub.send(b.id, { type: "speech.gesture", ...gesture, nextAudio: ev.id });
              }
            }
            hub.sendAudio(b.id, ev.data);
            break;
          }
          case "speak_done":
            if (ev.error && (b.init?.id === ev.id || b.turn?.pending.has(ev.id))) hub.send(b.id, { type: "error", text: ev.error });
            if (b.init?.id === ev.id) { b.init.done = true; if (!b.playing) finishInit(b); }
            else if (b.turn?.pending.has(ev.id)) { b.turn.pending.delete(ev.id); b.turn.gestures?.delete(ev.id); maybeFinish(b, b.turn); }
            break;
          case "closed":
            b.stream = undefined;
            break;
        }
  };
}
