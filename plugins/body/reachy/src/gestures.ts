// Gestes de Reachy Mini : images-clés (comme reachy/reachy_body/moves.py) et table émotion → geste.
// Angles en degrés. `pitch` positif = tête vers le bas, `yaw` positif = vers la gauche du robot,
// `antennas` = [droite, gauche]. On les convertit en radians pour le daemon (voir toGoto).
import { EMOTIONS, type BodyState, type Emotion } from "@floppy/protocol";

export interface Keyframe {
  /** Secondes pour atteindre la pose. */
  d: number;
  roll?: number;
  pitch?: number;
  yaw?: number;
  /** Hauteur de la tête en millimètres. */
  z?: number;
  antennas?: [number, number];
  bodyYaw?: number;
}

const k = (d: number, rest: Omit<Keyframe, "d"> = {}): Keyframe => ({ d, ...rest });
const REST = k(0.8);

export const GESTURES: Record<string, Keyframe[]> = {
  rest: [REST],
  // « oui »
  nod: [k(0.3, { pitch: 15 }), k(0.3, { pitch: -8 }), k(0.3, { pitch: 15 }), k(0.35)],
  // Petit hochement d'écoute (« je t'entends »), pendant que l'utilisateur parle
  nod_small: [k(0.25, { pitch: 7 }), k(0.3)],
  // « non »
  shake: [k(0.3, { yaw: 25 }), k(0.35, { yaw: -25 }), k(0.35, { yaw: 25 }), k(0.35, { yaw: -15 }), k(0.3)],
  // « content » : antennes qui frétillent
  happy: [
    k(0.25, { roll: 8, z: 8, antennas: [40, -40] }), k(0.2, { roll: -8, z: 8, antennas: [-40, 40] }),
    k(0.2, { roll: 8, z: 8, antennas: [40, -40] }), k(0.2, { roll: -8, z: 8, antennas: [-40, 40] }),
    k(0.2, { z: 8, antennas: [30, 30] }), k(0.4),
  ],
  look_left: [k(0.8, { yaw: 35, bodyYaw: 15 })],
  look_right: [k(0.8, { yaw: -35, bodyYaw: -15 })],
  look_up: [k(0.7, { pitch: -20, z: 5 })],
  look_down: [k(0.7, { pitch: 20 })],
  look_front: [REST],
  // Danse : balancement de la tête et des antennes, environ 4 secondes.
  dance: [
    k(0.4, { roll: 15, yaw: 15, antennas: [50, -20] }), k(0.4, { roll: -15, yaw: -15, antennas: [-20, 50] }),
    k(0.4, { roll: 15, yaw: 15, z: 8, antennas: [50, -20] }), k(0.4, { roll: -15, yaw: -15, z: 8, antennas: [-20, 50] }),
    k(0.3, { pitch: 15, antennas: [40, 40] }), k(0.3, { pitch: -10, antennas: [-30, -30] }),
    k(0.3, { pitch: 15, antennas: [40, 40] }), k(0.3, { pitch: -10, antennas: [-30, -30] }),
    k(0.5, { roll: 10, antennas: [60, 60] }), k(0.7),
  ],
  // Tête penchée : curieux, attentif
  tilt: [k(0.6, { roll: 18, pitch: -5, antennas: [20, 20] })],
  // Tête basse, antennes tombantes : triste, désolé
  droop: [k(1.0, { pitch: 22, z: -4, antennas: [-35, -35] })],
  // Antennes dressées : surpris, aux aguets
  perk: [k(0.3, { pitch: -10, z: 6, antennas: [60, 60] }), k(0.5, { pitch: -4, antennas: [40, 40] })],
  // Secoue lentement : perplexe
  puzzle: [k(0.6, { yaw: 14, roll: 8 }), k(0.8, { yaw: -14, roll: -8 }), k(0.7)],
  // Petits tremblements : colère, agacé
  grumpy: [k(0.3, { pitch: 10, antennas: [-20, -20] }), k(0.15, { yaw: 8 }), k(0.15, { yaw: -8 }), k(0.15, { yaw: 8 }), k(0.4, { pitch: 8, antennas: [-20, -20] })],
  // Recule : peur
  scared: [k(0.25, { pitch: -12, z: -6, antennas: [70, 70] }), k(0.12, { yaw: 6 }), k(0.12, { yaw: -6 }), k(0.12, { yaw: 6 }), k(0.5, { z: -4, antennas: [40, 40] })],
  // Clin d'œil : malicieux
  mischief: [k(0.4, { roll: 12, yaw: 10, antennas: [45, -10] }), k(0.5, { roll: 12, yaw: 10, antennas: [45, -10] }), k(0.5)],
  // Endormi : tête qui tombe, antennes basses
  sleepy: [k(1.5, { pitch: 25, z: -6, antennas: [-50, -50] })],
  // Fier : tête haute
  proud: [k(0.7, { pitch: -14, z: 8, antennas: [35, 35] })],
  // Timide : tête de côté, baissée
  shy: [k(0.8, { pitch: 14, yaw: -15, roll: -8, antennas: [-15, -15] })],
};

/** Les 28 émotions du protocole → une poignée de gestes. */
export const EMOTION_GESTURE: Record<Emotion, string> = {
  neutral: "rest",
  happy: "happy", joy: "happy", laugh: "happy", love: "happy", excited: "dance", relieved: "happy", determined: "proud",
  proud: "proud",
  sad: "droop", cry: "droop", sorry: "droop", bored: "droop",
  angry: "grumpy", annoyed: "grumpy",
  scared: "scared",
  surprised: "perk", shocked: "perk",
  confused: "puzzle", skeptical: "puzzle",
  mischief: "mischief", wink: "mischief",
  shy: "shy",
  tired: "sleepy", sleepy: "sleepy",
  thinking: "look_up",
  curious: "tilt",
  focused: "look_front",
};

// Vérifié à l'écriture des tests : toutes les émotions ont un geste qui existe.
export const MISSING_EMOTIONS = EMOTIONS.filter((e) => !(EMOTION_GESTURE[e] && GESTURES[EMOTION_GESTURE[e]]));

/** Gestes de fond selon l'état (jamais prioritaires sur un geste d'émotion en cours). */
export const STATE_GESTURE: Record<BodyState, string | undefined> = {
  sleep: "sleepy",
  idle: "rest",
  listening: "perk",
  thinking: "look_up",
  speaking: undefined,
};

export const DIRECTIONS: Record<string, string> = {
  left: "look_left",
  right: "look_right",
  up: "look_up",
  down: "look_down",
  front: "look_front", forward: "look_front", ahead: "look_front", straight: "look_front",
};

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Corps de la requête POST /api/move/goto du daemon (angles en radians, hauteur en mètres). */
export function toGoto(f: Keyframe) {
  return {
    head_pose: { x: 0, y: 0, z: (f.z ?? 0) / 1000, roll: rad(f.roll ?? 0), pitch: rad(f.pitch ?? 0), yaw: rad(f.yaw ?? 0) },
    antennas: [rad(f.antennas?.[0] ?? 0), rad(f.antennas?.[1] ?? 0)],
    body_yaw: rad(f.bodyYaw ?? 0),
    duration: f.d,
    interpolation: "minjerk",
  };
}
