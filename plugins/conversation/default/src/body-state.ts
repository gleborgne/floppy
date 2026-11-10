// État d'un corps : la phase montrée est décidée ici, et seulement ici. `reduce(drapeaux, événement, maintenant)` applique
// un événement nommé (mot d'activation, « dors », bouton parler, début de tour, annonce…) aux drapeaux qui décident
// de la phase et rend les nouveaux drapeaux avec l'état à montrer ; `showState` calcule cet état (« muet ⇒ sleep »
// n'existe que là). Les appelants (index.ts, voice-events.ts, initiatives.ts) n'écrivent plus ces drapeaux et ne
// choisissent plus d'état : ils envoient des événements à `dispatch` (index.ts). La table `TRANSITIONS` est un filet de
// diagnostic : `setState` journalise une transition absente (état « state.unexpected »), il ne la refuse jamais, et les
// tests du réducteur vérifient que toute transition qu'il produit y figure.
import type { BodyState } from "@floppy/protocol";

/** Phase de travail d'un corps éveillé (« sleep » n'en est pas une : c'est `muted` qui l'impose). */
export type BodyPhase = Exclude<BodyState, "sleep">;

/** Les drapeaux d'un corps qui décident de son état. */
export interface BodyFlags {
  muted: boolean;
  /** Un tour de conversation est en cours (lu seulement : il appartient à `turn.ts`). */
  turn: boolean;
  /** Une initiative (annonce, voie rapide) est en cours de lecture (lu seulement : elle appartient aux initiatives). */
  init: boolean;
  /** Le corps joue de l'audio. */
  playing: boolean;
  /** Bouton parler maintenu. */
  ptt?: boolean;
  /** Fin de la fenêtre d'écoute libre (ms epoch). */
  awakeUntil: number;
  /** La parole en cours a commencé pendant l'écoute libre : sa phrase compte même si elle arrive après la fin de la fenêtre. */
  speechOpen?: boolean;
  /** Phase de travail (idle si absente) ; l'état montré en découle (voir `showState`). */
  phase?: BodyPhase;
}

/** Une phrase entendue maintenant est adressée à Floppy sans mot d'activation (bouton parler ou écoute libre). */
export function canListenWithoutWake(f: Pick<BodyFlags, "muted" | "ptt" | "awakeUntil">, now: number): boolean {
  return !!f.ptt || (!f.muted && now <= f.awakeUntil);
}

/** État pris quand l'écoute libre (re)commence : « sleep » si le corps est muet, sinon « listening ». */
export function openListeningState(f: Pick<BodyFlags, "muted">): BodyState {
  return f.muted ? "sleep" : "listening";
}

/** L'état montré, calculé d'après les drapeaux : la seule règle « muet ⇒ sleep ». */
export function showState(f: Pick<BodyFlags, "muted" | "phase">): BodyState {
  return f.muted ? "sleep" : (f.phase ?? "idle");
}

/** Événements nommés qui font vivre la phase d'un corps. */
export type BodyEvent =
  /** Mot d'activation, saisie ou fin de la veille. `ms` : l'écoute libre s'ouvre pour cette durée (et « listening » est montré). */
  | { type: "wake"; ms?: number }
  /**
   * Le détecteur a entendu le mot d'activation : « listening » est montré, sans toucher à la fenêtre d'écoute libre.
   * `ms` : durée de l'activation, qui sert seulement au minuteur de retour au repos si aucune phrase ne suit.
   */
  | { type: "listening_started"; ms?: number }
  /** « Floppy, dors » (voix, texte, Live). */
  | { type: "sleep" }
  /** Bouton muet du corps. */
  | { type: "mute" }
  | { type: "unmute" }
  /** Bouton parler enfoncé (écoute tant que la touche est tenue, 60 s au plus) puis relâché (écoute libre ensuite). */
  | { type: "ptt_on" }
  | { type: "ptt_off" }
  /** La dictée prend la main : le bouton parler est lâché sans rouvrir d'écoute. */
  | { type: "ptt_dropped" }
  /** L'écoute libre s'ouvre (coupure de parole…) pour la durée du réglage. */
  | { type: "open_listening" }
  /** Croix « arrêter l'écoute » : ignorée si le corps n'écoute pas ou si une réponse a commencé. */
  | { type: "close_listening" }
  /** Le minuteur de l'écoute libre a sonné. */
  | { type: "listening_expired" }
  /** Parole détectée par le VAD. */
  | { type: "speech_detected" }
  /** Texte reconnu : la phrase compte dans la fenêtre d'écoute si elle y a commencé. */
  | { type: "transcript" }
  /** Texte écarté (« mhm ») : la parole en cours ne compte plus. */
  | { type: "speech_dropped" }
  /** Un tour commence à réfléchir. */
  | { type: "turn_started" }
  /** Premier audio d'une phrase (tour ou annonce) : le corps parle. */
  | { type: "speech_started" }
  /** Le tour est fini : écoute libre après la voix, repos après le texte. */
  | { type: "turn_finished"; voice: boolean }
  | { type: "turn_interrupted" }
  /** Une annonce est dite hors tour. */
  | { type: "announce_started" }
  /** Fin de l'annonce : l'écoute libre s'ouvre pour qu'on puisse répondre sans le mot. */
  | { type: "announce_finished" }
  | { type: "announce_aborted" }
  /** Réglage en voie rapide (sans tour) : il réfléchit, puis finit au repos sur un corps sans voix. */
  | { type: "quick_started" }
  | { type: "quick_finished" }
  /** L'utilisateur répond à un accord pendant la parole : le son est coupé, le tour attend l'outil. */
  | { type: "approval_barge_in" }
  /** Lecture audio du corps. */
  | { type: "playback"; on: boolean }
  /** Le mode Live annonce sa propre phase. */
  | { type: "live_state"; state: BodyState };

export interface ReduceOptions {
  /** Durée de l'écoute libre (ms). */
  freeListenMs: number;
  /** Fenêtre ouverte par le bouton parler tant qu'il est tenu (ms). */
  pttMs?: number;
}

export interface Reduced {
  flags: BodyFlags & { phase: BodyPhase; speechOpen: boolean; ptt: boolean };
  /** L'état à montrer. */
  state: BodyState;
  /** L'événement n'a eu aucun effet (la croix pendant une réponse) : l'appelant ne fait rien de plus. */
  ignored?: true;
  /** L'écoute libre vient de s'ouvrir : armer le minuteur de sa fin (`listening_expired`) dans ce délai (ms). */
  listenFor?: number;
}

const PTT_MS = 60_000;
/** Marge d'une phrase commencée dans la fenêtre d'écoute et finie après. */
const LATE_SPEECH_MS = 1000;
/** Marge du minuteur de fin d'écoute libre, pour qu'il sonne après la fin de la fenêtre. */
export const LISTENING_TIMER_MARGIN_MS = 50;

/**
 * Applique un événement aux drapeaux. Pure : pas d'horloge ni d'effet de bord (le temps arrive par `now`).
 * Les drapeaux `turn` et `init` sont lus (ils appartiennent à `turn.ts` et aux initiatives), jamais écrits.
 */
export function reduce(flags: BodyFlags, event: BodyEvent, now: number, opts: ReduceOptions): Reduced {
  const f: Reduced["flags"] = { ...flags, phase: flags.phase ?? "idle", speechOpen: !!flags.speechOpen, ptt: !!flags.ptt };
  const free = opts.freeListenMs;
  let listenFor: number | undefined;
  /** Rend le minuteur de fin d'écoute quand « listening » est montré avec une fin prévue (jamais tant que le bouton parler est tenu). */
  const rearm = () => {
    if (f.phase === "listening" && !f.muted && !f.ptt && !f.turn && !f.init) listenFor = Math.max(f.awakeUntil - now, 0) + LISTENING_TIMER_MARGIN_MS;
  };
  /** Après une coupure sans suite : l'écoute libre encore ouverte continue (avec son minuteur), sinon repos. */
  const afterCut = () => {
    if (f.turn || f.init) return;
    f.phase = !f.muted && (f.ptt || now < f.awakeUntil) ? "listening" : "idle";
    rearm();
  };
  const openWindow = () => { f.awakeUntil = now + free; f.phase = "listening"; listenFor = free + LISTENING_TIMER_MARGIN_MS; };
  switch (event.type) {
    case "wake":
      if (f.muted) f.phase = "idle";
      f.muted = false;
      if (event.ms !== undefined) { f.awakeUntil = now + event.ms; f.phase = "listening"; listenFor = event.ms + LISTENING_TIMER_MARGIN_MS; }
      break;
    case "listening_started":
      f.phase = "listening";
      if (event.ms !== undefined && !f.muted) listenFor = event.ms + LISTENING_TIMER_MARGIN_MS;
      break;
    case "sleep": case "mute": f.muted = true; f.awakeUntil = 0; f.speechOpen = false; f.phase = "idle"; break;
    case "unmute": f.muted = false; f.phase = "idle"; break;
    case "ptt_on": f.ptt = true; f.muted = false; f.awakeUntil = now + (opts.pttMs ?? PTT_MS); f.phase = "listening"; break;
    case "ptt_off": f.ptt = false; f.awakeUntil = now + free; rearm(); break;
    case "ptt_dropped": f.ptt = false; break;
    case "open_listening": openWindow(); break;
    case "close_listening":
      if (showState(f) !== "listening" || f.turn || f.init || f.playing) return { flags: f, state: showState(f), ignored: true };
      f.awakeUntil = 0; f.speechOpen = false; f.ptt = false; f.phase = "idle";
      break;
    case "listening_expired":
      // Ni pendant le bouton parler, ni pendant une parole commencée dans la fenêtre (son transcript ou son abandon rearme).
      if (!f.turn && !f.init && !f.playing && !f.ptt && !f.speechOpen && showState(f) === "listening" && now >= f.awakeUntil) f.phase = "idle";
      break;
    case "speech_detected": {
      const inWindow = !f.muted && now < f.awakeUntil;
      f.speechOpen = inWindow;
      if (!f.turn && inWindow) f.phase = "listening";
      break;
    }
    case "transcript":
      // La fenêtre couvre cette phrase : elle a commencé dedans, même si elle arrive après la fin.
      if (f.speechOpen && !f.muted && now > f.awakeUntil) f.awakeUntil = now + LATE_SPEECH_MS;
      f.speechOpen = false;
      rearm();
      break;
    case "speech_dropped": f.speechOpen = false; rearm(); break;
    case "turn_started": case "quick_started": f.phase = "thinking"; break;
    case "speech_started": f.playing = true; f.phase = "speaking"; break;
    case "turn_finished":
      if (event.voice) openWindow(); else f.phase = "idle";
      break;
    case "quick_finished": f.phase = "idle"; break;
    case "turn_interrupted": case "announce_aborted": f.playing = false; afterCut(); break;
    case "announce_started": f.phase = "speaking"; break;
    case "announce_finished": f.playing = false; openWindow(); break;
    case "approval_barge_in": f.playing = false; f.phase = "listening"; break;
    case "playback": f.playing = event.on; if (!event.on) rearm(); break;
    case "live_state":
      f.phase = event.state === "sleep" ? "idle" : event.state;
      if (!f.muted && event.state === "listening") f.awakeUntil = now + free;
      break;
  }
  return { flags: f, state: showState(f), ...(listenFor === undefined ? {} : { listenFor }) };
}

/**
 * Transitions autorisées, de l'état actuel vers le suivant. Rester dans le même état et passer en veille
 * (muet, « dors », corps débranché) sont toujours permis ; le reste est listé ici.
 */
export const TRANSITIONS: Readonly<Record<BodyState, readonly BodyState[]>> = {
  // Réveil : mot d'activation, saisie, bouton parler ou fin de la veille.
  sleep: ["idle", "listening", "thinking"],
  // Repos : on l'appelle, on lui écrit, ou une annonce est dite.
  idle: ["listening", "thinking", "speaking"],
  // Écoute : une demande part au cerveau, l'écoute se ferme, une annonce est dite.
  listening: ["idle", "thinking", "speaking"],
  // Réflexion : la réponse est dite, ou le tour finit (voix : écoute libre ; texte : repos).
  thinking: ["speaking", "listening", "idle"],
  // Parole : fin de tour (écoute libre ou repos), ou une nouvelle demande coupe la réponse.
  speaking: ["listening", "idle", "thinking"],
};

/** Vrai si passer de `from` à `to` est prévu. */
export function isExpectedTransition(from: BodyState, to: BodyState): boolean {
  return from === to || to === "sleep" || TRANSITIONS[from].includes(to);
}
