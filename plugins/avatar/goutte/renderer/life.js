// Le « vivant » commun des avatars à shader plein cadre (goutte, iris, oscillo, pixelcat) : état, émotion, humeur,
// regard, oreille, voix, ressort, respiration, hochement, clignement. UNE SEULE source, ici (scripts/avatar/life.js) ;
// chaque avatar en garde une copie identique octet pour octet à côté de son dessin (renderer/life.js), car un plugin
// ne dépend pas d'un autre et son dessin doit marcher seul. Ne pas modifier une copie : modifier cette source puis
//   npm run vendor:avatars
// Le test avatar-life.test.ts échoue si une copie diffère de la source.

// Émotion du protocole (28) → jeu de paramètres de l'avatar.
const EMO = {
  happy: "happy", joy: "happy", laugh: "happy", excited: "happy", proud: "happy", relieved: "happy",
  love: "love", shy: "love", sad: "sad", cry: "sad", sorry: "sad",
  angry: "angry", annoyed: "angry", determined: "angry",
  surprised: "surprised", shocked: "surprised", scared: "surprised",
  confused: "confused", skeptical: "confused", wink: "wink", mischief: "wink",
  sleepy: "sleep", tired: "sleep", bored: "sleep", thinking: "thinking", curious: "thinking", focused: "thinking",
};
/** Émotion légère (intensité < 0.6) : une version plus douce. */
const MILD = { angry: "confused", surprised: "idle", love: "happy" };
const BIG = ["joy", "laugh", "excited", "surprised", "shocked", "love", "angry", "scared"];

/** Fait glisser chaque valeur de cur vers tgt (nombres et tableaux de nombres). */
export function approach(cur, tgt, k) {
  for (const f in tgt) {
    const v = tgt[f];
    if (Array.isArray(v)) for (let i = 0; i < v.length; i++) cur[f][i] += (v[i] - cur[f][i]) * k;
    else cur[f] += (v - cur[f]) * k;
  }
}

/**
 * Le « vivant » commun : état, émotion (avec durée), humeur, regard, oreille, voix, ressort, hochement, clignement.
 * tick(now) avance tout ; L.key = le jeu de paramètres voulu maintenant (veille > émotion > état ; au repos, l'humeur).
 */
export function makeLife(reducedMotion, motion) {
  const L = {
    motion: { nod: 0, lean: 0, lookX: 0, lookY: 0, smile: 0, open: 0 },
    state: "idle", emotion: "neutral", intensity: 1, until: 0, level: 0, levelS: 0, hearing: 0, hearingS: 0,
    mood: { valence: 0.2, energy: 0.6 }, gaze: { x: 0, y: 0, at: -1e9 }, look: { x: 0, y: 0 },
    pop: 0, popV: 0, nodAt: -1e9, flashEmo: "", flashUntil: 0, blinkAt: 0, blinkT: -1e9, blink: 0,
    t: 0, dt: 0, last: performance.now(), key: "idle", breathe: 0, nod: 0,
  };
  const kick = (v) => { if (!reducedMotion) L.popV += v; };
  function wanted(now) {
    if (L.state === "sleep") return "sleep";
    const e = L.flashUntil > now ? L.flashEmo : L.emotion;
    if (e !== "neutral") { const k = EMO[e] ?? "idle"; return L.intensity < 0.6 ? MILD[k] ?? k : k; }
    if (L.state === "listening" || L.state === "thinking" || L.state === "speaking") return L.state;
    if (L.mood.energy < 0.15) return "sleep";
    if (L.mood.valence < -0.45) return "sad";
    return "idle";
  }
  L.tick = (now) => {
    const dt = Math.min(0.05, Math.max(0, (now - L.last) / 1000));
    L.last = now;
    L.dt = dt;
    const pose = !reducedMotion && L.state === "speaking" ? motion?.sample() : null;
    for (const key in L.motion) L.motion[key] += ((pose?.[key] ?? 0) - L.motion[key]) * (1 - Math.exp(-dt * 12));
    if (L.until && now > L.until) { L.emotion = "neutral"; L.until = 0; }
    L.key = wanted(now);
    L.levelS += (L.level - L.levelS) * Math.min(1, dt * 18);
    L.hearingS += (L.hearing - L.hearingS) * Math.min(1, dt * (L.hearing > L.hearingS ? 14 : 4));
    const g = motion?.gaze() ?? (now - L.gaze.at < 5000 ? L.gaze : { x: 0, y: 0 });
    L.look.x += (g.x - L.look.x) * Math.min(1, dt * 4);
    L.look.y += (g.y - L.look.y) * Math.min(1, dt * 4);
    const wk = 2 * Math.PI * 2.4;
    L.popV += (-wk * wk * L.pop - 2 * 0.45 * wk * L.popV) * dt;
    L.pop = Math.max(-0.25, Math.min(0.25, L.pop + L.popV * dt));
    L.breathe = reducedMotion ? 0 : Math.sin((now / 1000) * (0.9 + L.mood.energy * 0.7));
    const np = (now - L.nodAt) / 420;
    L.nod = np >= 0 && np < 1 && !reducedMotion ? Math.sin(np * Math.PI) : 0;
    if (!L.blinkAt) L.blinkAt = now + 1500 + Math.random() * 3000;
    if (now > L.blinkAt) { L.blinkT = now; L.blinkAt = now + (Math.random() < 0.2 ? 260 : 2500 + Math.random() * 4500); }
    const bp = (now - L.blinkT) / 170;
    L.blink = bp >= 0 && bp < 1 && L.key !== "sleep" ? Math.sin(bp * Math.PI) : 0;
    L.t += dt * (reducedMotion ? 0.3 : 1);
  };
  L.api = {
    setState(s) { L.state = s; },
    setEmotion(name, i, ms) {
      const e = EMO[name] || name === "neutral" ? name : "neutral";
      L.intensity = Number.isFinite(i) ? i : 1;
      if (e !== L.emotion && BIG.includes(e)) kick(-1.0 * L.intensity);
      L.emotion = e;
      L.until = ms ? performance.now() + ms : 0;
    },
    setLevel(v) { L.level = Math.max(0, Math.min(1, Number(v) || 0)); },
    setMood(valence, energy) { L.mood = { valence: Number(valence) || 0, energy: Number.isFinite(energy) ? energy : 0.6 }; },
    lookAt(x, y) {
      const nx = Math.max(-1, Math.min(1, x)), ny = Math.max(-1, Math.min(1, y));
      if (Math.abs(nx - L.gaze.x) + Math.abs(ny - L.gaze.y) > 0.02) L.gaze = { x: nx, y: ny, at: performance.now() };
    },
    setHearing(v) { L.hearing = Math.max(0, Math.min(1, Number(v) || 0)); },
    cue(name) {
      const now = performance.now();
      if (name === "nod") L.nodAt = now;
      else if (name === "perk") kick(0.8);
      else if (name === "startle") { kick(1.2); L.flashEmo = "surprised"; L.flashUntil = now + 600; }
      else if (name === "poke") { kick(-1.5); L.flashEmo = "wink"; L.flashUntil = now + 700; }
    },
    resize() { /* la taille est relue à chaque image */ },
  };
  return L;
}

/** Teinte de l'humeur au repos : un peu plus chaud si content, un peu plus froid si triste. */
export function moodTint(col, mood) {
  const v = Math.max(-1, Math.min(1, mood.valence));
  const d = v > 0 ? [0.25, 0.05, -0.2] : [-0.1, -0.05, 0.1];
  return col.map((c, i) => c + d[i] * Math.abs(v) * 0.5);
}
