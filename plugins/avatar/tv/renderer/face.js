// Visage de l'avatar : moteur d'émotions et d'animation. Le dessin est fait par le shader WebGL (face-gl.js).
// Une émotion = un jeu de paramètres. L'état (écoute, réfléchit, parle, veille) s'ajoute par-dessus.
// Pour que le visage ait l'air vivant :
// - Ressorts : chaque paramètre suit sa cible comme un ressort un peu souple (il dépasse un peu, puis revient).
// - Élan : une émotion vive commence par un petit tassement, puis le visage « saute » (impulsion sur le ressort).
// - Intensité : 0.45 donne un petit sourire, 1 le sourire normal, 1.25 un grand sourire.
// - Humeur : sans émotion en cours, le visage montre l'humeur (joyeux, penaud, fatigué) au lieu du neutre.
// - Respiration, clignements (parfois doubles), regard qui suit la souris, oreille qui réagit à la voix entendue.
// - Signaux : hochement de tête (nod), se redresser (perk), sursaut (startle), réaction à un clic (poke),
//   « oui ? » quand il entend son nom (wake).
import { createGLRenderer } from "./face-gl.js";
import { SpeechGestures } from "./speech-gestures.js";

const BASE = {
  eyeW: 46, eyeH: 56, eyeR: 15, eyeY: -10, gap: 94,
  lidTop: 0, lidAngle: 0, lidBot: 0,
  mouth: 0, mouthOpen: 0, mouthW: 0, mouthY: 52, mouthTilt: 0,
  lookX: 0, lookY: 0, tilt: 0, scale: 1, speechLift: 0,
  hue: 0, blush: 0, heart: 0, halo: 0.55,
  // asymétrie : facteurs pour l'œil gauche (L) et droit (R)
  hL: 1, hR: 1, topL: 0, topR: 0, botL: 0, botR: 0,
};

/** Émotions -> paramètres (différences par rapport à BASE) + détails (fx). */
export const EMOTION_PRESETS = {
  neutral:    {},
  happy:      { lidBot: 0.42, mouth: 0.7, mouthW: 41 },
  joy:        { lidBot: 0.52, mouth: 1, mouthOpen: 0.45, mouthW: 51, halo: 0.8, fx: ["sparkle"] },
  laugh:      { lidBot: 0.6, eyeH: 46, mouth: 1, mouthOpen: 0.9, mouthW: 59, halo: 0.85, fx: ["bounce"] },
  love:       { heart: 1, hue: 1, blush: 1, mouth: 0.7, mouthW: 35, halo: 0.9 },
  excited:    { eyeW: 52, eyeH: 64, eyeR: 18, mouth: 0.9, mouthOpen: 0.5, mouthW: 46, halo: 0.9, fx: ["sparkle", "bounce"] },
  proud:      { lidTop: 0.32, lidBot: 0.28, mouth: 0.55, mouthW: 41, mouthTilt: 0.25, lookY: -4 },
  sad:        { lidTop: 0.32, lidAngle: -22, eyeY: -4, mouth: -0.6, mouthW: 35, hue: 2, lookY: 6, halo: 0.35 },
  cry:        { lidTop: 0.3, lidAngle: -24, eyeY: -4, mouth: -0.8, mouthOpen: 0.25, mouthW: 38, hue: 2, lookY: 6, halo: 0.35, fx: ["tears"] },
  angry:      { lidTop: 0.42, lidAngle: 26, mouth: -0.45, mouthW: 41, hue: 3, halo: 0.8, fx: ["anger"] },
  annoyed:    { lidTop: 0.52, mouth: -0.1, mouthW: 24, lookX: 10, mouthTilt: -0.2 },
  scared:     { eyeW: 36, eyeH: 42, eyeR: 18, mouth: -0.3, mouthOpen: 0.3, mouthW: 24, lookY: 4, fx: ["sweat", "shake"] },
  surprised:  { eyeW: 52, eyeH: 62, eyeR: 26, mouthOpen: 0.7, mouthW: 19, halo: 0.75 },
  shocked:    { eyeW: 56, eyeH: 68, eyeR: 28, mouthOpen: 1, mouthW: 22, eyeY: -14, halo: 0.85, fx: ["exclaim"] },
  confused:   { hL: 0.75, topR: 0.2, mouth: -0.15, mouthW: 24, mouthTilt: 0.35, tilt: -5, fx: ["question"] },
  skeptical:  { topL: 0.5, botR: 0.1, mouth: -0.1, mouthW: 30, mouthTilt: -0.4, lookX: -6 },
  mischief:   { lidTop: 0.28, lidAngle: 12, lidBot: 0.22, mouth: 0.6, mouthW: 35, mouthTilt: 0.45, lookX: 8 },
  wink:       { botL: 0.75, hL: 0.35, mouth: 0.7, mouthW: 38, mouthTilt: 0.2 },
  shy:        { lidBot: 0.3, lookY: 8, lookX: -8, blush: 1, mouth: 0.35, mouthW: 22, tilt: 4 },
  bored:      { lidTop: 0.56, mouthW: 24, lookX: -12, lookY: 2, halo: 0.3 },
  tired:      { lidTop: 0.5, lidAngle: -8, eyeY: -6, mouthW: 22, mouth: -0.1, halo: 0.3, fx: ["sway"] },
  sleepy:     { eyeH: 5, eyeR: 3, eyeY: -4, mouthW: 16, halo: 0.22, fx: ["zzz"] },
  thinking:   { lidBot: 0.12, lookX: 12, lookY: -10, mouthW: 19, mouthTilt: 0.3, halo: 0.7, fx: ["dots"] },
  curious:    { hR: 1.12, topL: 0.12, tilt: 7, mouthOpen: 0.2, mouthW: 14, lookX: 4, halo: 0.7 },
  focused:    { lidTop: 0.3, eyeW: 42, mouthW: 22, halo: 0.65 },
  sorry:      { lidTop: 0.26, lidAngle: -16, mouth: -0.3, mouthW: 27, lookY: 5, halo: 0.4, fx: ["sweat"] },
  relieved:   { lidTop: 0.22, lidBot: 0.36, mouth: 0.45, mouthW: 32, fx: ["sweat"] },
  determined: { lidTop: 0.34, lidAngle: 14, mouth: -0.05, mouthW: 35, halo: 0.75 },
};

const HUES = [
  [64, 230, 236],  // 0 cyan
  [255, 84, 168],  // 1 rose (amour)
  [96, 160, 255],  // 2 bleu (tristesse)
  [255, 86, 58],   // 3 orange-rouge (colère)
];
const STATE_HALO = { idle: 1, listening: 1.7, thinking: 1.25, speaking: 1.35, sleep: 0.4 };
// `hue` est un numéro de couleur : il ne glisse pas (la couleur rgb, elle, glisse).
const NUM_KEYS = Object.keys(BASE).filter((k) => k !== "hue");
/** Émotions vives : elles commencent par un tassement, puis un saut (élan). */
const LIVELY = { joy: 1, laugh: 1, excited: 1.2, surprised: 1, shocked: 1.3, scared: 0.8, angry: 0.7, love: 0.6, proud: 0.5 };
/** Émotions lourdes : le visage s'affaisse un peu. */
const HEAVY = { sad: 1, cry: 1, sorry: 0.6, tired: 0.7, bored: 0.5 };
/** Détails qui restent même pour une émotion légère (ils font l'émotion). */
const KEEP_FX = new Set(["zzz", "dots", "question", "tears"]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Départ et arrivée à vitesse et accélération nulles : les accents se relient sans impulsion.
const easeGesture = (x) => { const p = clamp(x, 0, 1); return p * p * p * (p * (p * 6 - 15) + 10); };
const ACCENT_RISE_MS = 140, ACCENT_FALL_MS = 340;
/** Ajoute à t l'écart d'un preset par rapport à BASE, multiplié par w. */
function blend(t, preset, w) {
  if (!w) return;
  for (const key of NUM_KEYS) if (preset[key] !== undefined) t[key] += (preset[key] - BASE[key]) * w;
}

export class Face {
  /**
   * @param {HTMLCanvasElement | null} canvas  null : pas de rendu propre (la galerie dessine elle-même)
   * @param {{ background?: boolean, reducedMotion?: boolean }} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.background = opts.background ?? true;
    this.reducedMotion = !!opts.reducedMotion;
    this.cur = { ...BASE, rgb: [...HUES[0]] };
    this.vel = Object.fromEntries(NUM_KEYS.map((k) => [k, 0]));
    this.emotion = "neutral";
    this.intensity = 1;
    this.state = "idle";
    this.attention = "idle";
    this.level = 0;
    this.levelSmooth = 0;
    this.speechAccent = 0;
    this.speechSway = 0;
    this.speechAccents = [];
    this.speechGestures = new SpeechGestures();
    this.motion = opts.motion;
    this.speechTime = 0;
    this.speechSide = 1;
    this.lastSpeechAccent = -Infinity;
    this.previousLevel = 0;
    this.breathPhase = 0;
    this.breathRate = 1.56;
    this.breathAmplitude = 1.2;
    this.listeningBlend = 0;
    this.hearing = 0;
    this.hearingSmooth = 0;
    this.mood = { valence: 0.2, energy: 0.6 };
    this.gaze = { x: 0, y: 0, at: -1e9 };
    this.blink = 0;
    this.blinkStart = 0;
    this.blinkLen = 160;
    this.secondBlink = 0;
    this.nextBlink = performance.now() + 2500;
    this.saccade = { x: 0, y: 0, until: 0 };
    this.emotionUntil = 0;
    this.moves = [];          // { kind, start, dur } : hochement, sursaut, secousse de clic
    this.flash = null;        // { fx, until } : détail bref (« ! » du sursaut)
    this.t0 = performance.now();
    this.lastStep = this.t0;
    this.fx = new Set();
    if (canvas) {
      this.renderer = createGLRenderer(canvas);
      if (!this.renderer) console.warn("WebGL2 indisponible : avatar non dessiné");
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  setEmotion(name, ms, intensity) {
    const next = EMOTION_PRESETS[name] ? name : "neutral";
    const i = clamp(Number.isFinite(intensity) ? intensity : 1, 0.2, 1.3);
    if (next !== this.emotion || i > this.intensity + 0.3) this.onChange(next, i);
    this.emotion = next;
    this.intensity = i;
    this.emotionUntil = ms ? performance.now() + ms : 0;
  }
  setState(s) {
    if (s === this.state) return;
    // Réveil : les yeux s'ouvrent d'un coup, avec un petit rebond.
    if (this.state === "sleep" && s !== "sleep") this.kick({ scale: 0.5, eyeH: 40 });
    if (this.state === "speaking" && s === "listening") { this.moves = []; this.flash = null; }
    this.state = s;
    if (s !== "speaking") { this.speechAccent = 0; this.speechSway = 0; this.speechAccents = []; this.previousLevel = 0; this.speechGestures.clear(); }
    this.attention = s;
  }
  /** Cible de conversation : priorité sur la souris, déplacement adouci par les ressorts. */
  setAttention(target) { this.attention = target; }
  setSpeechTime(seconds) { this.speechTime = seconds * 1000; }
  setSpeechGesture(intent, intensity = 1, at = this.speechTime / 1000) {
    if (intent === null || this.reducedMotion) this.speechGestures.clear();
    else this.speechGestures.play(intent, intensity, at * 1000);
  }
  setLevel(v) { this.level = v; }
  /** Humeur de fond (valence -1..1, énergie 0..1). */
  setMood(valence, energy) {
    this.mood = { valence: clamp(Number(valence) || 0, -1, 1), energy: clamp(Number.isFinite(energy) ? energy : 0.6, 0, 1) };
  }
  /** Où regarder : x, y entre -1 et 1 (souris, par rapport au visage). */
  lookAt(x, y) {
    const nx = clamp(x, -1, 1), ny = clamp(y, -1, 1);
    if (Math.abs(nx - this.gaze.x) + Math.abs(ny - this.gaze.y) > 0.02) this.gaze = { x: nx, y: ny, at: performance.now() };
  }
  /** Niveau de la voix entendue au micro (0..1). */
  setHearing(v) { this.hearing = clamp(Number(v) || 0, 0, 1); }
  /** Signal bref : nod (hochement), perk (se redresse), startle (sursaut), poke (on l'a touché), wake (il entend son nom). */
  cue(name) {
    const now = performance.now();
    if (name === "nod") this.moves.push({ kind: "nod", start: now, dur: 420 });
    else if (name === "perk") this.kick({ scale: 0.45, eyeH: 35 });
    else if (name === "wake") { this.kick({ scale: 1.1, eyeH: 80, halo: 2 }); this.moves.push({ kind: "nod", start: now + 120, dur: 380 }); }
    else if (name === "startle") {
      this.kick({ scale: 0.9, eyeH: 90, eyeW: 30 });
      this.flash = { fx: "exclaim", until: now + 650 };
    } else if (name === "poke") {
      this.kick({ scale: -1.3, eyeH: -60 });
      this.moves.push({ kind: "wobble", start: now, dur: 700 });
      this.blinkStart = now;
    }
  }
  /** Saute la transition (galerie, captures). */
  snap() {
    const { t } = this.target(performance.now());
    for (const key of NUM_KEYS) { this.cur[key] = t[key]; this.vel[key] = 0; }
    this.cur.rgb = [...t.rgb];
    this.levelSmooth = this.level;
    // Pas de clignement ni de geste en cours : la capture montre l'expression elle-même.
    this.blinkStart = 0; this.secondBlink = 0; this.blink = 0; this.moves = []; this.flash = null;
  }

  /** Impulsion sur les ressorts (vitesse ajoutée). Rien en mouvement réduit. */
  kick(v) {
    if (this.reducedMotion) return;
    for (const [k, x] of Object.entries(v)) this.vel[k] += x * 3;
  }

  onChange(next, i) {
    const now = performance.now();
    // Un clignement au changement d'expression, une fois sur deux : c'est ce que font les vrais visages.
    if (Math.random() < 0.5 && this.state !== "sleep") { this.blinkStart = now; this.blinkLen = 150; }
    const lively = LIVELY[next];
    if (lively) this.kick({ scale: -0.7 * lively * i, eyeH: 50 * lively * i });
    const heavy = HEAVY[next];
    if (heavy) this.kick({ eyeY: 18 * heavy * i, scale: -0.25 * heavy });
  }

  target(now) {
    if (this.emotionUntil && now > this.emotionUntil) { this.emotion = "neutral"; this.emotionUntil = 0; this.intensity = 1; }
    // Une émotion de repos ne doit pas faire dormir un visage en pleine conversation.
    const active = ["listening", "thinking", "speaking"].includes(this.state);
    const emotion = active && ["sleepy", "tired", "bored"].includes(this.emotion) ? "neutral" : this.emotion;
    const preset = EMOTION_PRESETS[emotion] ?? {};
    const t = { ...BASE };
    const k = emotion === "neutral" ? 0 : this.intensity;
    blend(t, preset, k);
    t.hue = k >= 0.35 && preset.hue !== undefined ? preset.hue : 0;
    const fx = new Set((preset.fx ?? []).filter((f) => k >= 0.6 || KEEP_FX.has(f)));
    const { valence, energy } = this.mood;
    // Humeur : visible au repos, et un peu sous les émotions légères.
    const moodW = emotion === "neutral" ? 1 : clamp(1 - k, 0, 0.5);
    if (moodW && this.state !== "sleep") {
      // Le sourire d'humeur commence au-dessus du caractère de base (0.2) : au repos normal, visage neutre.
      if (valence > 0.3) blend(t, EMOTION_PRESETS.happy, (valence - 0.3) * 0.8 * moodW);
      if (valence < -0.1) blend(t, EMOTION_PRESETS.sorry, (-valence - 0.1) * 0.7 * moodW);
      if (energy < 0.35 && !active) blend(t, EMOTION_PRESETS.tired, ((0.35 - energy) / 0.35) * 0.8 * moodW);
      if (energy > 0.75) t.eyeH += (energy - 0.75) * 16 * moodW;
    }
    if (this.state === "sleep") { Object.assign(t, EMOTION_PRESETS.sleepy); delete t.fx; t.hue = 0; fx.clear(); fx.add("zzz"); }
    if (this.state === "listening") {
      if (emotion === "neutral") {
        blend(t, EMOTION_PRESETS.curious, 0.65);
        t.mouth = 0.35; t.mouthW = 28;
      }
      t.scale *= 1.06 + this.hearingSmooth * 0.06;
      t.eyeH += this.hearingSmooth * 8;
      t.lookX *= 0.3; t.lookY *= 0.3;
    }
    if (this.state === "thinking" && emotion === "neutral") { Object.assign(t, EMOTION_PRESETS.thinking); delete t.fx; fx.add("dots"); }
    if (this.state === "speaking") {
      if (!t.mouthW) t.mouthW = 28;
      // L'émotion colore l'articulation mais ne maintient pas la bouche ouverte dans les pauses.
      t.mouthOpen = Math.min(1, this.levelSmooth * (1.5 + t.mouthOpen * 0.5));
      // La bouche s'élargit un peu avec la voix, et change de forme d'une syllabe à l'autre.
      const time = (now - this.t0) / 1000;
      t.mouthW += this.levelSmooth * (8 + Math.sin(time * 13.7) * 4);
      const accent = this.reducedMotion ? 0 : this.speechAccent;
      t.eyeH += accent * 9;
      t.tilt += (this.reducedMotion ? 0 : this.speechSway) * 5.4;
      // Toute la posture passe par les ressorts, y compris le soulèvement : aucun pic brut au rendu.
      if (!this.reducedMotion) t.speechLift = this.levelSmooth * 2.8 + accent * 9;
      t.lidTop = Math.max(0, t.lidTop - accent * 0.12);
      t.halo += accent * 0.12;
    }
    t.halo *= STATE_HALO[this.state] ?? 1;
    if (this.state === "listening") t.halo *= 1 + this.hearingSmooth * 0.4;
    if (this.state !== "sleep") t.halo *= 0.75 + 0.45 * energy;
    // Regard : il suit la souris (surtout quand il écoute), sinon il regarde un peu partout au repos.
    const attentive = now - this.gaze.at < 5000;
    const gw = this.state === "listening" ? 1 : this.state === "speaking" ? 0.5 : this.state === "idle" ? 0.85 : 0;
    if (attentive && gw && Math.abs(preset.lookX ?? 0) < 9) {
      t.lookX += this.gaze.x * 18 * gw;
      t.lookY += this.gaze.y * 10 * gw;
    } else if (this.state === "idle" && this.emotion === "neutral") {
      if (now > this.saccade.until) {
        const r = Math.random();
        this.saccade = r < 0.55 ? { x: 0, y: 0, until: now + 1500 + Math.random() * 2500 }
          : { x: (Math.random() - 0.5) * 26, y: (Math.random() - 0.5) * 12, until: now + 700 + Math.random() * 1400 };
      }
      t.lookX += this.saccade.x; t.lookY += this.saccade.y;
    }
    if (this.flash && now < this.flash.until) fx.add(this.flash.fx);
    t.rgb = HUES[t.hue] ?? HUES[0];
    if (this.attention === "listening") { t.lookX = 0; t.lookY = 0; }
    else if (this.attention === "thinking") { t.lookX = 10; t.lookY = -8; }
    else if (this.attention === "speaking") {
      // Garde le regard expressif de l'émotion ; atténue seulement le suivi de souris.
      t.lookX = (preset.lookX ?? 0) + (t.lookX - (preset.lookX ?? 0)) * 0.25;
      t.lookY = (preset.lookY ?? 0) + (t.lookY - (preset.lookY ?? 0)) * 0.25;
      if (!this.reducedMotion) t.lookX += this.speechSway * 4;
    }
    else if (this.attention === "approval") { t.lookX = 0; t.lookY = -12; }
    if (this.state === "speaking" && this.attention !== "approval" && !this.reducedMotion) {
      const m = this.motion?.sample();
      const pose = m ? { tilt: m.lean * 2.6, lookX: m.lookX * 6.5, lookY: m.lookY * 4,
        eyeY: m.nod * 1.4, speechLift: -m.nod * 2.8, lidBot: m.smile * 0.1, mouth: m.smile * 0.14, hR: m.open * 0.08 }
        : this.speechGestures.sample(this.speechTime);
      for (const [key, value] of Object.entries(pose)) t[key] += value;
    }
    return { t, fx };
  }

  /** Avance l'animation d'une image et rend les paramètres du shader. */
  step(now) {
    const dt = clamp((now - this.lastStep) / 1000, 0, 0.05);
    this.lastStep = now;
    // Changer d'état ne doit pas changer brutalement la phase de respiration ou ajouter un balancement.
    const rate = this.state === "sleep" ? 0.9 : this.state === "listening" ? 2.4 : 1.2 + this.mood.energy * 0.6;
    const breathingEase = 1 - Math.exp(-dt * 6);
    const previousRate = this.breathRate;
    this.breathRate += (rate - this.breathRate) * breathingEase;
    this.breathPhase += (previousRate + this.breathRate) * 0.5 * dt;
    this.breathAmplitude += ((this.state === "sleep" ? 2.2 : 1.2) - this.breathAmplitude) * breathingEase;
    this.listeningBlend += ((this.state === "listening" ? 1 : 0) - this.listeningBlend) * breathingEase;
    // Accents sur les attaques, avec un temps de repos : une voix soutenue ne fait pas osciller la tête en boucle.
    if (this.state === "speaking" && !this.reducedMotion && this.level > 0.12
        && this.level - this.previousLevel > 0.08 && now - this.lastSpeechAccent > 420) {
      this.speechSide *= -1;
      this.speechAccents.push({ start: now, strength: Math.min(1, (this.level - this.previousLevel) * 2.5) * 0.6, side: this.speechSide });
      this.lastSpeechAccent = now;
    }
    this.speechAccents = this.speechAccents.filter(a => now - a.start < ACCENT_RISE_MS + ACCENT_FALL_MS);
    this.speechAccent = 0; this.speechSway = 0;
    for (const a of this.speechAccents) {
      const age = now - a.start;
      const envelope = age < ACCENT_RISE_MS ? easeGesture(age / ACCENT_RISE_MS)
        : 1 - easeGesture((age - ACCENT_RISE_MS) / ACCENT_FALL_MS);
      const weight = a.strength * envelope;
      this.speechAccent += weight;
      // Chaque geste garde sa direction jusqu'au bout, même si le suivant part de l'autre côté.
      this.speechSway += weight * a.side;
    }
    this.previousLevel = this.level;
    const { t, fx } = this.target(now);
    this.fx = fx;
    if (this.reducedMotion || !dt) {
      // Mouvement réduit : simple glissement, sans rebond.
      const k = dt ? 1 - Math.exp(-dt * 12) : 0.16;
      for (const key of NUM_KEYS) { this.cur[key] += (t[key] - this.cur[key]) * k; this.vel[key] = 0; }
    } else {
      // Ressort un peu souple : ω = 2π·2.6 Hz, amortissement 0.55 (dépasse d'environ 12 %, puis revient).
      const w = 2 * Math.PI * 2.6;
      for (const key of NUM_KEYS) {
        // Posture plus amortie ; petits pas pour garder la même souplesse à 30 comme à 60 images/s.
        const posture = ["tilt", "scale", "lookX", "lookY", "speechLift"].includes(key);
        const z = posture ? 0.72 : 0.55;
        const steps = posture ? Math.ceil(dt * 120) : 1;
        const h = dt / steps;
        for (let n = 0; n < steps; n++) {
          const a = -w * w * (this.cur[key] - t[key]) - 2 * z * w * this.vel[key];
          this.vel[key] += a * h;
          this.cur[key] += this.vel[key] * h;
        }
      }
    }
    // Garde-fous : un ressort ne doit jamais retourner un œil ou une paupière.
    for (const key of ["lidTop", "lidBot", "topL", "topR", "botL", "botR", "blush", "heart", "mouthOpen"]) this.cur[key] = clamp(this.cur[key], 0, 1);
    for (const key of ["eyeW", "eyeH", "eyeR", "mouthW"]) this.cur[key] = Math.max(0, this.cur[key]);
    this.cur.scale = clamp(this.cur.scale, 0.6, 1.5);
    const kc = dt ? 1 - Math.exp(-dt * 9) : 0.16;
    for (let i = 0; i < 3; i++) this.cur.rgb[i] += (t.rgb[i] - this.cur.rgb[i]) * kc;
    this.levelSmooth += (this.level - this.levelSmooth) * 0.35;
    this.hearingSmooth += (this.hearing - this.hearingSmooth) * (this.hearing > this.hearingSmooth ? 0.4 : 0.12);
    if (this.state !== "sleep") {
      const tired = 1 - this.mood.energy;
      if (now > this.nextBlink) {
        this.blinkStart = now;
        this.blinkLen = 150 + tired * 140; // fatigué : clignements plus lents
        // Une fois sur six : double clignement.
        this.secondBlink = Math.random() < 0.17 ? now + 260 : 0;
        this.nextBlink = now + (2200 + Math.random() * 4200) * (0.8 + this.mood.energy * 0.5);
      }
      if (this.secondBlink && now > this.secondBlink) { this.blinkStart = now; this.secondBlink = 0; }
      const b = this.blinkStart ? (now - this.blinkStart) / this.blinkLen : 2;
      this.blink = b < 1 ? Math.sin(b * Math.PI) : 0;
    } else this.blink = 0;
    this.moves = this.moves.filter((m) => now - m.start < m.dur);
    if (this.flash && now > this.flash.until) this.flash = null;
    return this.uniforms(now);
  }

  uniforms(now) {
    const c = this.cur, fx = this.fx;
    const time = (now - this.t0) / 1000;
    const still = this.reducedMotion;
    let ox = 0, oy = 0, tiltExtra = 0;
    if (fx.has("bounce")) oy -= Math.abs(Math.sin(time * 7)) * 5 * (still ? 0 : 1);
    if (fx.has("shake") && !still) ox += Math.sin(time * 40) * 1.5;
    if (fx.has("sway") && !still) ox += Math.sin(time * 1.3) * 3;
    if (!still) oy += Math.sin(time * 3) * 1.2 * this.listeningBlend;
    // Respiration : plus lente quand il est fatigué ou qu'il dort.
    const breathe = still ? 0 : Math.sin(this.breathPhase);
    oy += breathe * this.breathAmplitude;
    // La posture revient progressivement au repos, même quand la parole vient de s'arrêter.
    if (!still) oy -= c.speechLift;
    for (const m of this.moves) {
      const p = (now - m.start) / m.dur;
      if (m.kind === "nod") { oy += Math.sin(p * Math.PI) * 7; tiltExtra += Math.sin(p * Math.PI) * 1.5; }
      if (m.kind === "wobble") tiltExtra += Math.sin(p * Math.PI * 4) * (1 - p) * 7;
    }
    const eyes = [-1, 1].map((side) => {
      const L = side < 0;
      const ex = side * c.gap / 2 + c.lookX;
      const ey = c.eyeY + c.lookY * 0.8;
      const hh = c.eyeH * (L ? c.hL : c.hR) * (1 - this.blink * 0.92) * c.scale;
      const ww = c.eyeW * c.scale;
      const top = Math.max(c.lidTop, L ? c.topL : c.topR);
      const a = ((L ? -1 : 1) * -c.lidAngle * Math.PI) / 180;
      const n = [-Math.sin(a), Math.cos(a)];
      const P = [ex, ey - hh / 2 + hh * top];
      const bot = Math.max(c.lidBot, L ? c.botL : c.botR);
      const R = ww * 0.8;
      return {
        x: ex, y: ey, hw: ww / 2, hh: hh / 2, r: Math.min(c.eyeR * c.scale, hh / 2, ww / 2),
        lidTop: [n[0], n[1], n[0] * P[0] + n[1] * P[1]], lidTopOn: top > 0.01,
        lidBot: [ex, ey + hh / 2 + R - hh * bot * 1.2, R], lidBotOn: bot > 0.01, bot,
      };
    });
    const mw = c.mouthW * 1.3, my = c.mouthY + c.lookY * 0.4, mx = c.lookX * 0.5;
    const tilt = c.mouthTilt * 8, curve = c.mouth * 15, open = c.mouthOpen * 13;
    return {
      time, ox, oy, tilt: ((c.tilt + tiltExtra) * Math.PI) / 180, scale: 1,
      // Respiration : la tête grandit un tout petit peu à l'inspiration (appliqué par frame, pas par la galerie).
      breath: 1 + breathe * 0.0095 + (still ? 0 : c.speechLift * 0.0007),
      color: c.rgb.map((v) => v / 255), level: this.levelSmooth, halo: c.halo, background: this.background,
      eyes, heart: c.heart, blush: c.blush,
      mouth: { on: mw > 2, ax: mx - mw / 2, ay: my - tilt, cx: mx + mw / 2, cy: my + tilt, bx: mx, by: my + curve, botY: my + curve + open * 3.2, open: c.mouthOpen },
      fx: {
        tears: +fx.has("tears"), sweat: +fx.has("sweat"), zzz: +fx.has("zzz"), sparkle: +fx.has("sparkle"),
        question: +fx.has("question"), exclaim: +fx.has("exclaim"), anger: +fx.has("anger"), dots: +fx.has("dots"),
      },
    };
  }

  /** Arrête l'animation et libère le contexte WebGL (changement d'avatar). */
  destroy() {
    this.dead = true;
    try { this.canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* déjà perdu */ }
  }

  frame(now) {
    if (this.dead) return;
    if (this.renderer) {
      const r = this.canvas.getBoundingClientRect();
      const u = this.step(now);
      u.scale = Math.min(r.width / 420, r.height / 330) * u.breath;
      this.renderer.draw(u, r.width, r.height, window.devicePixelRatio || 1);
    }
    requestAnimationFrame((t) => this.frame(t));
  }
}
