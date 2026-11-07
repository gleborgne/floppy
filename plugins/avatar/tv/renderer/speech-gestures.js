// Petites séquences sémantiques sur l'horloge audio. Aucun timer ni lecture du texte dans l'avatar.
const zero = () => ({ tilt: 0, lookX: 0, lookY: 0, eyeY: 0, speechLift: 0, lidBot: 0, mouth: 0, hR: 0 });
const ease = (x) => { const p = Math.max(0, Math.min(1, x)); return p ** 3 * (p * (p * 6 - 15) + 10); };
const pulse = (t, delay, rise, fall) => t < delay ? 0 : t < delay + rise
  ? ease((t - delay) / rise) : 1 - ease((t - delay - rise) / fall);

export class SpeechGestures {
  constructor() { this.sequence = 0; this.active = null; this.previous = null; }
  clear() { this.active = null; this.previous = null; }
  play(intent, intensity, at) {
    // Les petits fragments successifs ne doivent pas faire recommencer le même geste sans arrêt.
    if (intent !== "none" && this.active?.intent === intent && at - this.active.at < 700) return;
    this.previous = { pose: this.sample(at), at };
    if (!["explain", "playful", "question"].includes(intent)) { this.active = null; return; }
    const n = this.sequence++;
    this.active = { intent, at, side: n % 2 ? 1 : -1,
      strength: Math.max(0, Math.min(1.3, Number.isFinite(intensity) ? intensity : 1)) * [1, 0.9, 1.05][n % 3] };
  }
  sample(now) {
    const out = zero();
    const a = this.active;
    if (a) {
      const t = now - a.at, s = a.strength;
      if (a.intent === "explain") {
        const nod = pulse(t, 100, 230, 340) + 0.65 * pulse(t, 700, 210, 350);
        out.eyeY = nod * 1.4 * s; out.speechLift = -nod * 2.8 * s;
        out.tilt = nod * 0.9 * a.side * s;
      } else if (a.intent === "playful") {
        const smile = pulse(t, 140, 320, 740) * s;
        out.tilt = smile * 2.2 * a.side; out.lookX = smile * 5 * a.side;
        out.lidBot = smile * 0.1; out.mouth = smile * 0.14;
      } else {
        const search = pulse(t, 60, 340, 850) * s;
        out.tilt = search * 2.6 * a.side; out.lookX = search * 6.5 * a.side;
        out.lookY = -search * 4; out.hR = search * 0.08;
      }
    }
    if (this.previous) {
      const weight = 1 - ease((now - this.previous.at) / 220);
      for (const key of Object.keys(out)) out[key] += this.previous.pose[key] * weight;
    }
    return out;
  }
}
