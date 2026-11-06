// Avatar « iris » : un œil-caméra à diaphragme. Les lamelles s'ouvrent quand il écoute et se ferment quand il dort.
// Un anneau de 24 LED montre l'état (écoute vers le micro, réflexion qui tourne, niveau de la voix…). Pas de bouche.
// Tout est peint par le GPU (WebGL2) : 1 fragment shader plein cadre, avec des formes à distance signée (SDF)
// pour le boîtier, les LED, l'hexagone du diaphragme, les lamelles et les paupières. 1 appel de dessin par image.
// - Une émotion = un jeu de paramètres (ouverture, regard, paupières, couleur…). Tout glisse vers sa cible.
// Vivant : humeur au repos, regard (l'œil suit la souris), oreille (il s'ouvre avec la voix entendue), voix (LED et
// pupille suivent le niveau), ressort, hochement, sursaut, clic, clignement (le diaphragme se ferme d'un coup).

// ---- Partie commune aux avatars « shader plein cadre » (copiée dans chaque avatar : un plugin ne dépend pas d'un autre). ----
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
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const D = Math.PI / 180;

const QVS = `#version 300 es
in vec2 aPos; out vec2 vP; uniform vec2 uAsp;
void main() { vP = aPos / uAsp; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Un canvas WebGL2 et un programme qui peint tout le cadre (1 appel de dessin par image). */
function surface(container, fs) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  container.append(canvas);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) throw new Error("WebGL2 indisponible");
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, QVS], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "programme");
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
    u[name] = gl.getUniformLocation(p, name);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(p, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return {
    gl, u,
    /** Peint une image. set(u, px) donne les uniformes ; px = taille d'un pixel dans les unités du dessin. */
    draw(zoom, set) {
      const b = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(b.width * dpr)), h = Math.max(1, Math.round(b.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      const m = Math.min(w, h);
      gl.useProgram(p);
      gl.bindVertexArray(vao);
      gl.uniform2f(u.uAsp, m / w, m / h);
      gl.uniform1f(u.uZoom, zoom);
      set(u, (2 * zoom) / m);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    destroy() { gl.getExtension("WEBGL_lose_context")?.loseContext(); canvas.remove(); },
  };
}

/** Fait glisser chaque valeur de cur vers tgt (nombres et tableaux de nombres). */
function approach(cur, tgt, k) {
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
function makeLife(reducedMotion) {
  const L = {
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
    if (L.until && now > L.until) { L.emotion = "neutral"; L.until = 0; }
    L.key = wanted(now);
    L.levelS += (L.level - L.levelS) * Math.min(1, dt * 18);
    L.hearingS += (L.hearing - L.hearingS) * Math.min(1, dt * (L.hearing > L.hearingS ? 14 : 4));
    const g = now - L.gaze.at < 5000 ? L.gaze : { x: 0, y: 0 };
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
function moodTint(col, mood) {
  const v = Math.max(-1, Math.min(1, mood.valence));
  const d = v > 0 ? [0.25, 0.05, -0.2] : [-0.1, -0.05, 0.1];
  return col.map((c, i) => c + d[i] * Math.abs(v) * 0.5);
}

// GLSL commun : trait courbé (yeux, sourcils), avec un rendu néon (cœur blanc + halo de couleur).
const GLSL_COMMON = `
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
// Trait de demi-longueur L, angle ang (0 = vertical), courbure bend (flèche au milieu), épaisseur w.
float stroke(vec2 p, vec2 c, float L, float ang, float bend, float w) {
  vec2 q = p - c;
  vec2 dir = vec2(sin(ang), cos(ang)), nr = vec2(cos(ang), -sin(ang));
  float s = dot(q, dir), n = dot(q, nr);
  float sc = clamp(s, -L, L);
  float off = L > 1e-4 ? bend * (1.0 - (sc / L) * (sc / L)) : 0.0;
  return length(vec2(n - off, s - sc)) - w * 0.5;
}
// Cœur (pour l'amour) centré en c, de taille r.
float heart(vec2 p, vec2 c, float r) {
  vec2 q = (p - c) / r; q.y = 0.55 - q.y; q.x = abs(q.x);
  if (q.y + q.x > 1.0) return (length(q - vec2(0.25, 0.75)) - 0.3536) * r;
  vec2 a = q - vec2(0.0, 1.0), b = q - 0.5 * max(q.x + q.y, 0.0);
  return sqrt(min(dot(a, a), dot(b, b))) * sign(q.x - q.y) * r;
}
// Néon : d = distance signée au trait (négative dedans), w = épaisseur. Renvoie la lumière ajoutée.
vec3 neon(float d, float w, vec3 c, float px) {
  float out_ = max(d, 0.0);
  float fill = 1.0 - smoothstep(-px, px, d);
  float core = 1.0 - smoothstep(-px, px, d + min(w * 0.32, max(w * 0.5 - 0.007, 0.0)));
  return c * (fill * 0.85 + exp(-out_ / 0.012) * 0.55 + exp(-out_ / 0.045) * 0.22) + vec3(core * 0.85);
}
`;
// ---- Fin de la partie commune. ----

// Paupières (dans la lentille, x et y entre -1 et 1) : haut = [y, pente, V, courbe], bas = [y, pente, courbe]. Loin = cachée.
const TOP_OFF = [-1.5, 0, 0, 0], BOT_OFF = [1.5, 0, 0];
// Par émotion : ouverture du diaphragme, décalage du regard, rotation des lamelles, paupières, cœur, couleur.
const P = {
  idle: { ap: 0.30, c: "#00E5FF" },
  listening: { ap: 0.44, c: "#00FFA3" },
  thinking: { ap: 0.24, dy: -0.12, rot: 15, c: "#A87BFF" },
  speaking: { ap: 0.34, c: "#00E5FF" },
  sleep: { ap: 0.04, top: [0, 0, 0, 0], c: "#3B4BD8", dim: 0.7 },
  happy: { ap: 0.30, dy: -0.12, bot: [0.06, 0, 0.30], c: "#FFD000" },
  sad: { ap: 0.26, dy: 0.06, top: [-0.32, 0, 0, 0.26], c: "#4D8BFF", dim: 0.85 },
  angry: { ap: 0.18, top: [-0.06, 0, -0.36, 0], c: "#FF2E4D" },
  surprised: { ap: 0.50, c: "#FF9E00" },
  love: { ap: 0.36, heart: 1, c: "#FF2BD6" },
  confused: { ap: 0.26, dx: 0.10, rot: 25, top: [-0.24, -0.16, 0, 0], c: "#A87BFF" },
  wink: { ap: 0.26, dy: -0.10, bot: [0.05, 0, 0.22], c: "#FFD000" },
};

// Anneau de 24 LED (0 = en haut, sens horaire, 12 = en bas, vers le micro) : la lumière voulue de chaque LED.
function leds(k, i, t, L) {
  const fromBottom = Math.abs(i - 12);
  switch (k) {
    case "listening": return fromBottom <= 4 ? 0.5 + 0.5 * L.hearingS : 0.1;
    case "thinking": { const d = (((t * 10 - i) % 24) + 24) % 24; return d < 6 ? 1 - d * 0.14 : 0.08; }
    case "speaking": return fromBottom <= L.levelS * 12.5 ? 1 : 0.15;
    case "sleep": return i === 12 ? 0.35 + 0.25 * L.breathe : 0.05;
    case "happy": return 0.75 + 0.25 * Math.sin(i * 0.52 - t * 3);
    case "surprised": return 1;
    case "sad": return i >= 7 && i <= 17 ? 0.4 : 0.05;
    case "angry": return (i + Math.floor(t * 4)) % 2 ? 1 : 0.2;
    case "love": { const beat = Math.max(0, Math.sin(t * 7)) ** 6; return i % 3 === 0 ? 0.6 + 0.4 * beat : 0.3 + 0.3 * beat; }
    case "confused": { const h = Math.sin((i + Math.floor(t * 3) * 7.13) * 91.7) * 43758.5; return h - Math.floor(h); }
    case "wink": return i >= 1 && i <= 11 ? 1 : 0.1;
    default: return 0.4 + 0.15 * Math.sin(i * 0.26 - t * 1.2);
  }
}

function snapshot(k) {
  const p = P[k];
  return {
    ap: p.ap, dx: p.dx ?? 0, dy: p.dy ?? 0, rot: (p.rot ?? 0) * D, heart: p.heart ?? 0,
    top: [...(p.top ?? TOP_OFF)], bot: [...(p.bot ?? BOT_OFF)], col: rgb(p.c).map((c) => c * (p.dim ?? 1)),
  };
}

const FS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform float uT, uZoom, uPx, uAp, uRot, uHeart, uPupil, uScale;
uniform vec2 uO;
uniform float uTop[4], uBot[3], uLed[24];
uniform vec3 uCol;
${GLSL_COMMON}
// Hexagone régulier (un sommet en haut quand rot = 0), r = rayon jusqu'au sommet.
float hexd(vec2 q, float r, float rot) {
  float c = cos(rot), s = sin(rot);
  q = mat2(c, -s, s, c) * q;
  q = abs(q.yx);
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  float ap = r * 0.866025404;
  q -= 2.0 * min(dot(k.xy, q), 0.0) * k.xy;
  q -= vec2(clamp(q.x, -k.z * ap, k.z * ap), ap);
  return length(q) * sign(q.y);
}
float segd(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float ring(float r, float rr, float w) { return abs(r - rr) - w * 0.5; }
void main() {
  vec2 p = vec2(vP.x, -vP.y) * uZoom / uScale;
  float r = length(p), px = uPx;
  vec3 col = vec3(0.0);
  float a = 0.0;
  // Boîtier, puis anneau de LED.
  col += uCol * 0.07 * (1.0 - smoothstep(0.97, 0.99, r));
  float house = 1.0 - smoothstep(0.88 - px, 0.88 + px, r);
  col = mix(col, vec3(0.082, 0.086, 0.11), house);
  col = mix(col, vec3(0.17, 0.18, 0.22), 1.0 - smoothstep(0.0, px, ring(r, 0.875, 0.03)));
  a = max(a, house);
  float th = atan(p.y, p.x);
  float li = mod(floor((th + 1.5707963) / 0.2617994 + 0.5), 24.0);
  float lt = -1.5707963 + li * 0.2617994;
  float lv = uLed[int(li)];
  float ld = length(p - 0.79 * vec2(cos(lt), sin(lt))) - 0.032;
  col += uCol * lv * (1.0 - smoothstep(-px, px, ld)) * 0.9 + uCol * lv * exp(-max(ld, 0.0) / 0.02) * 0.5
    + vec3(1.0) * lv * lv * (1.0 - smoothstep(-px, px, ld + 0.016)) * 0.5;
  // Bague, puis lentille.
  float bez = 1.0 - smoothstep(0.68 - px, 0.68 + px, r);
  col = mix(col, vec3(0.039, 0.043, 0.059), bez);
  col = mix(col, vec3(0.19, 0.2, 0.24), (1.0 - smoothstep(0.0, px, ring(r, 0.675, 0.02))) * bez);
  if (r < 0.64 + px) {
    float lens = 1.0 - smoothstep(0.64 - px, 0.64 + px, r);
    vec2 q = p - uO;
    float hd = hexd(q, uAp, uRot);
    // Dans le trou : la lumière de l'œil (pupille ou cœur) avec un cœur blanc.
    vec3 hole = vec3(0.02, 0.024, 0.04) + uCol * 0.22;
    float pr = uAp * 0.5 * uPupil;
    float pd = mix(length(q) - pr, heart(p, uO, pr * 1.5), uHeart);
    hole += uCol * (1.0 - smoothstep(-px, px, pd)) + uCol * exp(-max(pd, 0.0) / 0.03) * 0.5;
    hole += vec3(0.9) * (1.0 - smoothstep(-px, px, length(q) - max(0.012, uAp * 0.18))) * (1.0 - uHeart * 0.6);
    // Les lamelles : 6 secteurs un peu différents, avec leurs joints.
    float ba = atan(q.y, q.x) - uRot;
    float sec = mod(floor(ba / 1.0471976 + 0.5), 6.0);
    vec3 blade = vec3(0.149, 0.157, 0.188) * (0.85 + 0.3 * hash(sec + 3.0)) * (0.8 + 0.2 * smoothstep(0.64, 0.2, r));
    float sd = 1e3;
    for (int i = 0; i < 6; i++) {
      float va = uRot + float(i) * 1.0471976 - 1.5707963;
      vec2 v = uO + uAp * vec2(cos(va), sin(va));
      float ea = va + 1.0122910;
      sd = min(sd, segd(p, v, 0.66 * vec2(cos(ea), sin(ea))));
    }
    blade = mix(blade, vec3(0.235, 0.247, 0.29), 1.0 - smoothstep(0.004, 0.004 + px, sd));
    vec3 lc = mix(hole, blade, smoothstep(-px, px, hd));
    lc += uCol * 0.6 * (1.0 - smoothstep(0.004, 0.004 + px, abs(hd))) + uCol * exp(-abs(hd) / 0.02) * 0.15;
    // Paupières.
    float x = p.x;
    float ty = uTop[0] + uTop[1] * x + uTop[2] * abs(x) + uTop[3] * x * x;
    float tp = uTop[1] + uTop[2] * sign(x) + 2.0 * uTop[3] * x;
    float td = (p.y - ty) / sqrt(1.0 + tp * tp);
    float by = uBot[0] + uBot[1] * x + uBot[2] * x * x;
    float bp = uBot[1] + 2.0 * uBot[2] * x;
    float bd = (by - p.y) / sqrt(1.0 + bp * bp);
    float lid = min(td, bd);
    lc = mix(vec3(0.082, 0.086, 0.11), lc, smoothstep(-px, px, lid));
    lc += neon(abs(lid) - 0.0125, 0.025, uCol, px) * step(-0.2, -abs(lid));
    // Reflet de la lentille.
    vec2 sq = p - vec2(-0.24, -0.26);
    float cs = cos(0.61), sn = sin(0.61);
    sq = mat2(cs, -sn, sn, cs) * sq / vec2(0.14, 0.08);
    lc += vec3(0.1) * (1.0 - smoothstep(0.9, 1.0, length(sq)));
    col = mix(col, lc, lens);
  }
  a = clamp(max(a, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  o = vec4(min(col, vec3(a)), a);
}`;

export function create(container, { reducedMotion = false } = {}) {
  const sf = surface(container, FS);
  const gl = sf.gl;
  const L = makeLife(reducedMotion);
  const cur = snapshot("idle");
  const led = new Float32Array(24).fill(0.4);
  let tt = 0, raf = 0, dead = false;

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    L.tick(now);
    const dt = L.dt;
    tt += dt * (reducedMotion ? 0.3 : 1) * (L.key === "idle" ? 0.6 + 0.8 * L.mood.energy : 1);
    const tgt = snapshot(L.key);
    if (L.key === "idle") tgt.col = moodTint(tgt.col, L.mood);
    // Écoute : il s'ouvre plus fort quand la voix entendue monte.
    if (L.state === "listening") tgt.ap += L.hearingS * 0.08;
    approach(cur, tgt, Math.min(1, dt * (reducedMotion ? 6 : 4)));
    // Les LED suivent l'état (l'écoute et la parole se voient même avec une émotion).
    const ledKey = L.key === "idle" || L.key === "sleep" ? L.key : L.state === "listening" || L.state === "speaking" ? L.state : L.key;
    for (let i = 0; i < 24; i++) led[i] += (leds(ledKey, i, tt, L) - led[i]) * Math.min(1, dt * 12);
    // Clignement : le diaphragme se ferme d'un coup, puis se rouvre. Regard : l'œil glisse vers la souris.
    const ap = cur.ap * (1 - 0.85 * L.blink);
    const lim = Math.max(0, 0.6 - ap);
    let ox = cur.dx + L.look.x * 0.14, oy = cur.dy + L.look.y * 0.11 + L.nod * 0.05;
    const ol = Math.hypot(ox, oy);
    if (ol > lim) { ox *= lim / ol; oy *= lim / ol; }
    const scale = 1 + L.pop * 0.4 + L.breathe * 0.005;
    sf.draw(1.02, (u, px) => {
      gl.uniform1f(u.uT, tt);
      gl.uniform1f(u.uPx, px / scale);
      gl.uniform1f(u.uScale, scale);
      gl.uniform1f(u.uAp, ap);
      gl.uniform1f(u.uRot, cur.rot + (cur.ap - 0.3) * 2.2);
      gl.uniform1f(u.uHeart, cur.heart);
      gl.uniform1f(u.uPupil, 1 + (L.state === "speaking" ? L.levelS * 0.25 : 0));
      gl.uniform2f(u.uO, ox, oy);
      gl.uniform1fv(u.uTop, cur.top);
      gl.uniform1fv(u.uBot, cur.bot);
      gl.uniform1fv(u.uLed, led);
      gl.uniform3f(u.uCol, cur.col[0], cur.col[1], cur.col[2]);
    });
  }
  raf = requestAnimationFrame(frame);

  return {
    ...L.api,
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      sf.destroy();
    },
  };
}
