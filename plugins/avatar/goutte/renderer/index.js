// Avatar « goutte » : une goutte de gel sombre qui brille de l'intérieur. Pas de joues, pas de larmes, pas de bouche
// (sauf quand elle parle). L'humeur passe par la forme, la lumière, les bulles et 2 yeux de lumière.
// Tout est peint par le GPU (WebGL2) : 1 fragment shader plein cadre, avec des formes à distance signée (SDF)
// pour le corps mou, le bord néon, les bulles et les yeux. 1 appel de dessin par image.
// - Une émotion = un jeu de paramètres (forme, yeux, lueur, bulles, couleur…). Tout glisse vers sa cible : pas de saut.
// Vivant : humeur au repos, regard (les yeux suivent la souris), oreille, voix (la bouche suit le niveau), ressort
// (tassement puis rebond), hochement, sursaut, clic, clignement des yeux.

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
function makeLife(reducedMotion, motion) {
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

// Yeux et sourcils : [cx, cy, demi-longueur, angle, courbure, épaisseur], écrits en px du mockup (viewBox 200, centre 100,104).
const V = (x, a, b, w) => [(x - 100) / 100, ((a + b) / 2 - 104) / 100, (b - a) / 200, 0, 0, w / 100];
const A = (x1, y, xc, yc, x2, w) => [((x1 + x2) / 2 - 100) / 100, (y - 104) / 100, (x2 - x1) / 200, 90 * D, (y - yc) / 200, w / 100];
const S = (x1, y1, x2, y2, w) => [((x1 + x2) / 2 - 100) / 100, ((y1 + y2) / 2 - 104) / 100, Math.hypot(x2 - x1, y2 - y1) / 200, Math.atan2(x2 - x1, y2 - y1), 0, w / 100];
const M = (e) => [-e[0], e[1], e[2], -e[3], -e[4], e[5]];

// Formes du corps : [demi-largeur, haut, bas, pointe, frisson, fréquence du frisson]. Le bas est posé au sol.
const B = {
  base: [0.72, 0.82, 0.64, 0.10, 0, 7],
  squash: [0.80, 0.70, 0.50, 0.05, 0, 7],
  tall: [0.66, 0.92, 0.70, 0.18, 0, 7],
  wide: [0.80, 0.78, 0.60, 0.08, 0, 7],
  tense: [0.70, 0.82, 0.64, 0.12, 0.035, 9],
};
// Par émotion : corps, yeux, lueur interne (position, force), bulles (nombre, montée), ondes au sol, bouche, penché.
const P = {
  idle: { body: "base", el: V(80, 92, 104, 11), g: [0, 0.36, 0.5], bub: 5, c: "#6FE3D2" },
  listening: { body: "tall", el: V(80, 84, 106, 13), g: [0, 0.46, 0.75], bub: 6, ring: 1, c: "#7CC8FF" },
  thinking: { body: "base", el: V(88, 78, 88, 9), er: V(126, 78, 88, 9), g: [0.12, -0.30, 0.65], bub: 8, up: 1, c: "#A99BFF" },
  speaking: { body: "base", el: V(80, 92, 104, 11), g: [0, 0.26, 0.7], bub: 5, ring: 0.6, mouth: 1, c: "#6FE3D2" },
  sleep: { body: "squash", el: S(70, 108, 88, 108, 3), g: [0, 0.62, 0.25], bub: 2, c: "#5C6A99", dim: 0.6 },
  happy: { body: "wide", el: A(70, 102, 79, 92, 88, 4), g: [0, 0.16, 0.8], bub: 10, up: 1, c: "#FFD27A" },
  sad: { body: "squash", el: V(84, 108, 114, 8), g: [0, 0.64, 0.35], bub: 2, c: "#6F95E8", dim: 0.8 },
  angry: { body: "tense", el: S(70, 92, 88, 100, 5), g: [0, 0.16, 0.85], bub: 0, ring: 0.8, c: "#FF6F61" },
  surprised: { body: "tall", el: V(80, 80, 108, 16), g: [0, 0.06, 0.8], bub: 9, ring: 1, c: "#FFB27A" },
  love: { body: "wide", el: A(70, 102, 79, 92, 88, 4), g: [0, 0.06, 0.9], bub: 14, up: 1, c: "#FF8FC8" },
  confused: { body: "base", el: V(80, 88, 104, 10), er: V(122, 96, 102, 10), g: [0, 0.36, 0.5], bub: 5, tilt: -9, c: "#A99BFF" },
  wink: { body: "base", el: V(80, 92, 104, 11), er: A(112, 100, 121, 92, 130, 4), g: [0, 0.26, 0.6], bub: 5, tilt: 5, c: "#FFD27A" },
};
const STATE_GLOW = { idle: 1, listening: 1.15, thinking: 1.05, speaking: 1.1, sleep: 0.6 };

function snapshot(k) {
  const p = P[k];
  return {
    body: [...B[p.body]], el: [...p.el], er: p.er ? [...p.er] : M(p.el), g: [...p.g],
    bub: p.bub, up: p.up ?? 0, ring: p.ring ?? 0, mouth: p.mouth ?? 0, tilt: (p.tilt ?? 0) * D,
    col: rgb(p.c).map((c) => c * (p.dim ?? 1)),
  };
}

const FS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform float uT, uZoom, uPx, uBub, uUp, uRing, uMouth, uTilt, uLevel, uJig;
uniform vec3 uCol;
uniform float uBody[6], uE[12];
uniform vec2 uSq, uOff;
uniform vec3 uG;
${GLSL_COMMON}
const vec2 BASE = vec2(0.0, 0.72);   // le point d'appui de la goutte (bas du corps)
// Corps : une ellipse molle (haut et bas différents, un peu pointue en haut) qui frissonne.
float body(vec2 q, out vec2 nq) {
  vec2 d = q - vec2(0.0, -uBody[2]);
  float ry = d.y < 0.0 ? uBody[1] : uBody[2];
  float up = clamp(-d.y / uBody[1], 0.0, 1.0);
  float rx = uBody[0] * (1.0 - uBody[3] * up * up);
  nq = d / vec2(rx, ry);
  float th = atan(nq.y, nq.x);
  float wob = 0.012 * sin(3.0 * th + uT * 1.7) + 0.008 * sin(5.0 * th - uT * 2.3)
    + uBody[4] * sin(uBody[5] * th + uT * 6.0) + uJig * 0.03 * sin(6.0 * th + uT * 9.0);
  return (length(nq) - 1.0 - wob) * min(rx, ry);
}
void main() {
  vec2 p = vec2(vP.x, -vP.y) * uZoom;
  vec3 col = vec3(0.0);
  // Sol : une ombre de lumière, et des ondes qui s'éloignent (écoute, parole, colère, surprise).
  vec2 gq = (p - vec2(0.0, 0.80)) / vec2(0.52, 0.06);
  col += uCol * exp(-dot(gq, gq) * 1.2) * 0.30;
  for (int i = 0; i < 2; i++) {
    float k = fract(uT * 0.45 + float(i) * 0.5);
    vec2 rr = vec2(0.62, 0.08) * (1.0 + k * 0.6);
    float rd = abs(length((p - vec2(0.0, 0.83)) / rr) - 1.0) * rr.y;
    col += uCol * (1.0 - smoothstep(0.0, 0.006 + uPx, rd)) * uRing * (1.0 - k) * 0.6;
  }
  // Espace du corps : penché autour du point d'appui, tassé ou étiré par le ressort.
  vec2 q = p - BASE - uOff;
  float ct = cos(uTilt), st = sin(uTilt);
  q = mat2(ct, st, -st, ct) * q;
  q /= uSq;
  vec2 nq;
  float d = body(q, nq);
  float inside = 1.0 - smoothstep(-uPx, uPx, d);
  vec2 e = q + BASE;
  // Dedans : gel sombre, lueur interne, bulles, reflets.
  vec3 inC = vec3(0.043, 0.059, 0.086) + uCol * 0.14;
  vec2 gd = (e - uG.xy) / vec2(0.52, 0.40);
  inC += uCol * uG.z * exp(-dot(gd, gd) * 1.6) * 0.8;
  float bub = 0.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i), on = clamp(uBub - fi, 0.0, 1.0);
    if (on <= 0.0) break;
    float h1 = hash(fi + 1.0), h2 = hash(fi + 7.3), h3 = hash(fi + 13.1);
    float k = fract(h2 + uT * mix(0.04, 0.12, uUp) * (0.6 + 0.8 * h3));
    vec2 bc = vec2((h1 * 2.0 - 1.0) * 0.36 + sin(uT * 1.3 + fi) * 0.02, mix(0.58, mix(0.15, -0.50, uUp), k));
    float r = 0.015 + 0.03 * h3;
    float bd = abs(length(e - bc) - r);
    bub += (1.0 - smoothstep(0.004, 0.004 + uPx * 1.5, bd)) * on * sin(k * 3.14159);
  }
  inC += uCol * bub * 0.7;
  float hr = length(nq), ha = atan(nq.y, nq.x);
  inC += vec3(0.5) * exp(-pow((hr - 0.84) / 0.035, 2.0)) * smoothstep(-2.75, -2.45, ha) * (1.0 - smoothstep(-1.95, -1.65, ha));
  inC += vec3(0.25) * exp(-pow((hr - 0.88) / 0.025, 2.0)) * smoothstep(0.25, 0.45, ha) * (1.0 - smoothstep(0.85, 1.05, ha));
  col += inC * inside;
  // Bord : un fil de néon, avec un peu de halo dehors.
  float ad = abs(d);
  col += uCol * (exp(-ad / 0.010) * 0.9 + exp(-ad / 0.035) * 0.3) + vec3(0.35) * (1.0 - smoothstep(0.002, 0.002 + uPx, ad));
  col += uCol * (d > 0.0 ? exp(-d / 0.07) * 0.22 : 0.0);
  // Yeux de lumière, et la bouche (une petite onde) seulement quand elle parle.
  float e1 = stroke(e, vec2(uE[0], uE[1]), uE[2], uE[3], uE[4], uE[5]);
  float e2 = stroke(e, vec2(uE[6], uE[7]), uE[8], uE[9], uE[10], uE[11]);
  col += (e1 < e2 ? neon(e1, uE[5], uCol, uPx) : neon(e2, uE[11], uCol, uPx)) * mix(0.25, 1.0, inside);
  if (uMouth > 0.01) {
    vec2 mc = vec2((uE[0] + uE[6]) * 0.5, (uE[1] + uE[7]) * 0.5 + 0.34);
    float W = 0.16, x = e.x - mc.x, mx = clamp(x, -W, W);
    float amp = 0.015 + uLevel * 0.07, ph = (mx + W) / (2.0 * W) * 6.2832 + uT * 1.2;
    float f = mc.y - amp * sin(ph), fp = -amp * cos(ph) * 6.2832 / (2.0 * W);
    float md = length(vec2(x - mx, (e.y - f) / sqrt(1.0 + fp * fp))) - 0.02;
    col += neon(md, 0.04, uCol, uPx) * uMouth;
  }
  float a = clamp(max(inside, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  o = vec4(min(col, vec3(a)), a);
}`;

export function create(container, { reducedMotion = false, motion } = {}) {
  const sf = surface(container, FS);
  const gl = sf.gl;
  const L = makeLife(reducedMotion, motion);
  const cur = snapshot("idle");
  let glowK = 1, tt = 0, raf = 0, dead = false;

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    L.tick(now);
    const dt = L.dt;
    tt += dt * (reducedMotion ? 0.3 : 1) * (L.key === "idle" ? 0.6 + 0.8 * L.mood.energy : 1);
    const tgt = snapshot(L.key);
    tgt.tilt += L.motion.lean * 0.045;
    tgt.body[1] += L.motion.open * 0.025 - L.motion.nod * 0.035;
    tgt.body[0] += L.motion.smile * 0.025 + L.motion.nod * 0.02;
    if (L.state === "speaking") tgt.mouth = 1;
    if (L.state === "listening") tgt.ring = Math.max(tgt.ring, 0.5 + L.hearingS * 0.5);
    if (L.key === "idle") tgt.col = moodTint(tgt.col, L.mood);
    approach(cur, tgt, Math.min(1, dt * (reducedMotion ? 6 : 4)));
    glowK += ((STATE_GLOW[L.state] ?? 1) - glowK) * Math.min(1, dt * 3);
    // Regard : les yeux glissent vers la souris, la goutte penche un peu. Clignement : les yeux se ferment.
    const lx = L.look.x * 0.07 + L.motion.lookX * 0.04, ly = L.look.y * 0.05 + L.motion.lookY * 0.03;
    const eyes = [...cur.el, ...cur.er];
    for (const o of [0, 6]) {
      eyes[o] += lx; eyes[o + 1] += ly;
      eyes[o + 2] *= 1 - 0.85 * L.blink * Math.abs(Math.cos(eyes[o + 3]));
    }
    const sy = 1 - L.pop + L.breathe * 0.015 + (L.state === "listening" ? L.hearingS * 0.06 : 0) + L.levelS * 0.04 * (L.state === "speaking" ? 1 : 0);
    const sx = 1 + L.pop * 0.6 - L.breathe * 0.008;
    sf.draw(1.06, (u, px) => {
      gl.uniform1f(u.uT, tt);
      gl.uniform1f(u.uPx, px);
      gl.uniform1fv(u.uBody, cur.body);
      gl.uniform1fv(u.uE, eyes);
      gl.uniform3f(u.uG, cur.g[0], cur.g[1], cur.g[2] * glowK * (1 + L.hearingS * 0.3));
      gl.uniform1f(u.uBub, cur.bub);
      gl.uniform1f(u.uUp, cur.up);
      gl.uniform1f(u.uRing, cur.ring);
      gl.uniform1f(u.uMouth, cur.mouth);
      gl.uniform1f(u.uTilt, cur.tilt + L.look.x * 0.06);
      gl.uniform1f(u.uLevel, L.state === "speaking" ? L.levelS : 0);
      gl.uniform1f(u.uJig, L.state === "speaking" ? L.levelS : 0);
      gl.uniform2f(u.uSq, sx, sy);
      gl.uniform2f(u.uOff, 0, L.nod * 0.04 + L.motion.nod * 0.025);
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
