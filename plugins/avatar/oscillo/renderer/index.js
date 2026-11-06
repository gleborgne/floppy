// Avatar « oscillo » : un tube de néon rond, comme une enseigne de bar la nuit. Un cœur blanc très chaud, un halo
// de couleur, un double anneau (tube + anneau extérieur). La bouche est une onde d'oscilloscope qui suit la voix.
// Tout est peint par le GPU (WebGL2) : 1 fragment shader plein cadre, avec des formes à distance signée (SDF)
// pour les anneaux, les yeux, les sourcils et l'onde. 1 appel de dessin par image.
// - Une émotion = un jeu de paramètres (yeux, sourcils, forme de l'onde, couleurs…). Tout glisse vers sa cible.
// Vivant : humeur au repos, regard (le visage suit la souris), oreille (l'onde et l'anneau suivent la voix entendue),
// voix (l'onde et le tube vibrent avec le niveau), ressort, hochement, sursaut, clic, clignement, scintillement du néon.

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

// Yeux et sourcils : [cx, cy, demi-longueur, angle, courbure, épaisseur], écrits en px du mockup (viewBox 200, centre 100,104).
const V = (x, a, b, w) => [(x - 100) / 100, ((a + b) / 2 - 104) / 100, (b - a) / 200, 0, 0, w / 100];
const A = (x1, y, xc, yc, x2, w) => [((x1 + x2) / 2 - 100) / 100, (y - 104) / 100, (x2 - x1) / 200, 90 * D, (y - yc) / 200, w / 100];
const S = (x1, y1, x2, y2, w) => [((x1 + x2) / 2 - 100) / 100, ((y1 + y2) / 2 - 104) / 100, Math.hypot(x2 - x1, y2 - y1) / 200, Math.atan2(x2 - x1, y2 - y1), 0, w / 100];
const M = (e) => [-e[0], e[1], e[2], -e[3], -e[4], e[5]];
const NO_BROW = S(66, 84, 88, 84, 5);

// L'onde de la bouche : [ligne de base, sourire, onde, nombre d'ondes, largeur de la bosse, dents de scie, pic, pente, S, demi-largeur].
const W = {
  idle: [0.26, 0, 0.03, 1, 0.12, 0, 0, 0, 0, 0.50],
  listening: [0.26, 0, 0.03, 3, 9, 0, 0, 0, 0, 0.54],
  thinking: [0.26, 0, 0, 1, 9, 0, 0, 0, 0, 0.50],
  speaking: [0.26, 0, 0.04, 3, 9, 0, 0, 0, 0, 0.54],
  sleep: [0.28, 0, 0, 1, 9, 0, 0, 0, 0, 0.48],
  happy: [0.18, 0.17, 0, 1, 9, 0, 0, 0, 0, 0.50],
  sad: [0.38, -0.14, 0, 1, 9, 0, 0, 0, 0, 0.46],
  angry: [0.26, 0, 0, 1, 9, 0.06, 0, 0, 0, 0.50],
  surprised: [0.26, 0, 0, 1, 9, 0, 0.22, 0, 0, 0.52],
  love: [0.26, 0, 0, 1, 9, 0, 0.16, 0, 0, 0.54],
  confused: [0.29, 0, 0, 1, 9, 0, 0, 0.06, -0.12, 0.50],
  wink: [0.20, 0.13, 0, 1, 9, 0, 0, 0, 0, 0.50],
};
// Par émotion : yeux, sourcils, cœurs, points (réflexion), « ! » (surprise), couleur du tube et de l'anneau extérieur.
const P = {
  idle: { el: V(78, 90, 102, 11), c: "#00F0FF", c2: "#FF2BD6" },
  listening: { el: V(78, 86, 104, 13), c: "#00FFA3", c2: "#00F0FF" },
  thinking: { el: V(84, 82, 90, 10), er: V(128, 82, 90, 10), dots: 1, c: "#B06CFF", c2: "#FF2BD6" },
  speaking: { el: V(78, 90, 102, 11), c: "#00F0FF", c2: "#FF2BD6" },
  sleep: { el: A(68, 98, 78, 104, 88, 4), c: "#4058FF", c2: "#2A2F7A", dim: 0.55 },
  happy: { el: A(68, 100, 78, 86, 88, 5), c: "#FFE600", c2: "#FF2BD6" },
  sad: { el: V(78, 96, 104, 10), bl: S(66, 86, 88, 80, 5), brow: 1, c: "#3D8BFF", c2: "#7A4DFF", dim: 0.85 },
  angry: { el: V(78, 94, 102, 10), bl: S(66, 78, 90, 88, 5), brow: 1, c: "#FF2E4D", c2: "#FF9E00", flick: 1 },
  surprised: { el: V(78, 84, 104, 14), bang: 1, c: "#FF9E00", c2: "#FF2BD6" },
  love: { el: V(78, 94, 96, 3), heart: 1, c: "#FF2BD6", c2: "#B06CFF" },
  confused: { el: V(78, 90, 102, 10), er: V(122, 94, 98, 10), c: "#B06CFF", c2: "#00F0FF", flick: 0.5 },
  wink: { el: V(78, 90, 102, 11), er: A(112, 98, 122, 90, 132, 5), c: "#FFE600", c2: "#FF2BD6" },
};

function snapshot(k) {
  const p = P[k], dim = p.dim ?? 1;
  const bl = p.bl ?? NO_BROW;
  return {
    el: [...p.el], er: p.er ? [...p.er] : M(p.el), bl: [...bl], br: M(bl), w: [...W[k]],
    brow: p.brow ?? 0, heart: p.heart ?? 0, dots: p.dots ?? 0, bang: p.bang ?? 0, flick: p.flick ?? 0,
    col: rgb(p.c).map((c) => c * dim), col2: rgb(p.c2).map((c) => c * dim),
  };
}

const FS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform float uT, uZoom, uPx, uBrow, uHeart, uDots, uBang, uGlow, uLevel, uHear, uSpeak, uScale;
uniform vec3 uCol, uCol2;
uniform float uE[24], uW[10];
uniform vec2 uOff;
${GLSL_COMMON}
// L'onde de la bouche (y vers le bas), x entre -1 et 1 environ.
float wave(float x) {
  float u = x / uW[9];
  float y = uW[0] + uW[1] * (1.0 - u * u);
  y += -uW[2] * sin(u * 3.14159 * uW[3] + uT * 5.0) * exp(-x * x / (uW[4] * uW[4]));
  float tri = abs(fract(u * 2.25 + 0.25) * 2.0 - 1.0) * 2.0 - 1.0;
  y += uW[5] * tri;
  float k = fract(uT * 0.45) * 0.8 - 0.4;   // le pic du cœur avance ; celui de la surprise reste au milieu
  float c = mix(0.0, k, step(0.5, uHeart));
  y += uW[6] * (1.0 - smoothstep(0.3, 0.42, abs(c))) * (-exp(-pow((x - c + 0.03) / 0.028, 2.0)) + 0.9 * exp(-pow((x - c - 0.04) / 0.028, 2.0)));
  y += uW[7] * u + uW[8] * sin(u * 3.14159);
  return y;
}
void main() {
  vec2 p = vec2(vP.x, -vP.y) * uZoom / uScale;
  float r = length(p);
  vec3 col = vec3(0.0);
  float disk = 1.0 - smoothstep(0.80 - uPx, 0.80 + uPx, r);
  // L'écran rond : noir, lignes de balayage, réticule.
  vec3 bg = vec3(0.016, 0.012, 0.031);
  bg += vec3(0.05) * (1.0 - smoothstep(0.0, uPx * 1.5, abs(fract(p.y / 0.05 + uT * 0.15) - 0.5) * 0.05 - 0.002)) * 0.6;
  bg += uCol * 0.14 * (1.0 - smoothstep(0.0, uPx * 1.2, min(abs(p.x), abs(p.y)) - 0.003)) * step(r, 0.70);
  col += bg * disk;
  // Le double anneau de néon. L'intérieur vibre avec la voix ; l'extérieur s'allume en bas quand il écoute.
  float th = atan(p.y, p.x);
  float rin = 0.82 + uSpeak * uLevel * 0.012 * sin(th * 9.0 + uT * 14.0);
  float dIn = abs(r - rin) - 0.015, dOut = abs(r - 0.91) - 0.015;
  col += neon(dIn, 0.03, uCol, uPx) * uGlow;
  col += neon(dOut, 0.03, uCol2, uPx) * uGlow * (0.8 + uHear * 0.9 * smoothstep(0.3, 1.0, sin(th)));
  // Visage (suit le regard).
  vec2 f = p - uOff;
  float d = 1e3, w = 0.1;
  for (int i = 0; i < 2; i++) {
    int b = i * 6;
    float e = stroke(f, vec2(uE[b], uE[b + 1]), uE[b + 2], uE[b + 3], uE[b + 4], uE[b + 5]);
    float h = heart(f, vec2(uE[b], uE[b + 1] - 0.01), 0.15);
    e = mix(e, h, uHeart);
    if (e < d) { d = e; w = mix(uE[b + 5], 0.12, uHeart); }
    float br = stroke(f, vec2(uE[12 + b], uE[13 + b]), uE[14 + b], uE[15 + b], uE[16 + b], uE[17 + b]);
    if (uBrow > 0.01) col += neon(br + (1.0 - uBrow) * 0.08, 0.05, uCol, uPx) * uBrow;
  }
  col += neon(d, w, uCol, uPx);
  float x = f.x, mx = clamp(x, -uW[9], uW[9]);
  float y = wave(mx), yp = (wave(mx + 0.004) - wave(mx - 0.004)) / 0.008;
  float md = length(vec2(x - mx, (f.y - y) / sqrt(1.0 + yp * yp))) - 0.022;
  col += neon(md, 0.045, uCol, uPx);
  // Points de réflexion (ils sautent l'un après l'autre) et « ! » de surprise.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(0.38 + fi * 0.13, -0.42 - 0.03 * max(0.0, sin(uT * 5.0 - fi * 1.1)));
    col += neon(length(p - c) - 0.035 * uDots, 0.07, uCol, uPx) * uDots;
  }
  float bg2 = min(stroke(p, vec2(0.44, -0.52), 0.08, 0.0, 0.0, 0.06), length(p - vec2(0.44, -0.36)) - 0.03);
  col += neon(bg2 + (1.0 - uBang) * 0.06, 0.06, uCol, uPx) * uBang;
  // Halo de couleur autour du tube.
  col += uCol * exp(-max(r - 0.9, 0.0) / 0.08) * step(0.9, r) * 0.25 * uGlow;
  float a = clamp(max(disk, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  o = vec4(min(col, vec3(a)), a);
}`;

export function create(container, { reducedMotion = false } = {}) {
  const sf = surface(container, FS);
  const gl = sf.gl;
  const L = makeLife(reducedMotion);
  const cur = snapshot("idle");
  let tt = 0, raf = 0, dead = false, flickAt = 0, flickT = -1e9;

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    L.tick(now);
    const dt = L.dt;
    tt += dt * (reducedMotion ? 0.3 : 1) * (L.key === "idle" ? 0.6 + 0.8 * L.mood.energy : 1);
    const tgt = snapshot(L.key);
    if (L.key === "idle") { tgt.col = moodTint(tgt.col, L.mood); }
    // Écoute : l'onde suit la voix entendue. Parole : l'onde suit le niveau de la voix.
    if (L.state === "listening") tgt.w[2] = Math.max(tgt.w[2], 0.01 + L.hearingS * 0.09);
    if (L.state === "speaking") { tgt.w[2] = Math.max(tgt.w[2], 0.02 + L.levelS * 0.09); tgt.w[3] = 3; tgt.w[4] = 9; }
    approach(cur, tgt, Math.min(1, dt * (reducedMotion ? 6 : 5)));
    // Scintillement du néon : rare au repos, plus souvent en colère ou confus.
    if (!flickAt) flickAt = now + 4000;
    if (now > flickAt) { flickT = now; flickAt = now + (reducedMotion ? 1e9 : (6000 + Math.random() * 9000) / (1 + cur.flick * 4)); }
    const fp = (now - flickT) / 260;
    const glow = fp >= 0 && fp < 1 ? 0.55 + 0.45 * Math.abs(Math.sin(fp * 17)) : 0.92 + 0.08 * Math.sin(now / 90) * Math.sin(now / 37);
    const lx = L.look.x * 0.07, ly = L.look.y * 0.05;
    const face = [...cur.el, ...cur.er, ...cur.bl, ...cur.br];
    for (const o of [0, 6]) face[o + 2] *= 1 - 0.85 * L.blink * Math.abs(Math.cos(face[o + 3]));
    const scale = 1 + L.pop * 0.5 + L.breathe * 0.006 + (L.state === "speaking" ? L.levelS * 0.015 : 0);
    sf.draw(1.04, (u, px) => {
      gl.uniform1f(u.uT, tt);
      gl.uniform1f(u.uPx, px / scale);
      gl.uniform1f(u.uScale, scale);
      gl.uniform1fv(u.uE, face);
      gl.uniform1fv(u.uW, cur.w);
      gl.uniform1f(u.uBrow, cur.brow);
      gl.uniform1f(u.uHeart, cur.heart);
      gl.uniform1f(u.uDots, cur.dots);
      gl.uniform1f(u.uBang, cur.bang);
      gl.uniform1f(u.uGlow, glow);
      gl.uniform1f(u.uLevel, L.levelS);
      gl.uniform1f(u.uSpeak, L.state === "speaking" ? 1 : 0);
      gl.uniform1f(u.uHear, L.state === "listening" ? L.hearingS : 0);
      gl.uniform2f(u.uOff, lx, ly + L.nod * 0.05);
      gl.uniform3f(u.uCol, cur.col[0], cur.col[1], cur.col[2]);
      gl.uniform3f(u.uCol2, cur.col2[0], cur.col2[1], cur.col2[2]);
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
