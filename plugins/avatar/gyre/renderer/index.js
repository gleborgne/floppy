// Avatar « gyre » : une présence abstraite en 3D, sans visage. Un noyau en fil de lumière qui se déforme,
// entouré d'anneaux inclinés qui tournent comme un gyroscope, avec des points de lumière qui voyagent dessus.
// Tout est calculé par le GPU (WebGL2) : chaque trait est une suite de points lumineux placés par le vertex
// shader (sphère, anneaux, particules, effets). Additif : les traits brillent et se mélangent. 1 appel de dessin.
// - Une émotion = un jeu de paramètres (taille, déformation, pics, anneaux, couleur, vitesse…). Les paramètres
//   glissent vers leur cible : les changements sont fluides, jamais de saut.
// - L'état s'ajoute : l'écoute fait venir des ondes du bas (vers le micro), la parole fait onduler le noyau
//   avec le vrai niveau de la voix, la veille aplatit et éteint tout.
// Vivant : humeur au repos (vitesse, couleur), regard (la forme penche vers la souris), oreille (voix entendue),
// ressort (tassement puis rebond), hochement, sursaut, réaction au clic.

const S = 220;               // points par cercle de la sphère (11 cercles)
const RS = 380;              // points par anneau (3 anneaux)
const PJ = 8, PK = 12;       // particules par anneau, points par traînée
const N_SPH = 11 * S, N_RING = 3 * RS, N_PART = 3 * PJ * PK;
const N_PULSE = 2 * 180, N_LISTEN = 3 * 120, N_BURST = 16 * 10;
const TOTAL = 2 * N_SPH + N_RING + N_PART + N_PULSE + N_LISTEN + N_BURST;

const D = Math.PI / 180;
// Paramètres par émotion. rings : [rayon, inclinaison x°, inclinaison z°] (rayon 0 = pas d'anneau).
const P = {
  idle: { R: 0.30, d: 0.04, n: 3, m: 2, spike: 0, spin: 0.3, prec: 0.25, rings: [[0.62, 70, 10], [0.72, -60, 40], [0.82, 20, -70]], parts: 3, c: "#7FE9FF" },
  listening: { R: 0.32, d: 0.06, n: 3, m: 2, spike: 0, spin: 0.4, prec: 0.1, rings: [[0.64, 10, 0], [0.76, 20, 0], [0.88, 30, 0]], parts: 4, c: "#5CFFC8", listen: 1 },
  thinking: { R: 0.26, d: 0.05, n: 3, m: 2, spike: 0, spin: 0.9, prec: 1.2, rings: [[0.66, 90, 0], [0.66, 90, 60], [0.66, 90, 120]], parts: 7, c: "#B99CFF" },
  speaking: { R: 0.34, d: 0.12, n: 4, m: 3, spike: 0, spin: 0.4, prec: 0.3, rings: [[0.70, 70, 10], [0.84, -55, 35], [0, 20, -70]], parts: 3, c: "#7FE9FF", pulse: 1 },
  sleep: { R: 0.22, d: 0, n: 3, m: 2, spike: 0, spin: 0.05, prec: 0.03, rings: [[0.70, 86, 0], [0.78, 88, 0], [0, 88, 0]], parts: 0, c: "#4C5BB0", a: 0.5 },
  happy: { R: 0.34, d: 0.08, n: 2, m: 2, spike: 0, spin: 0.6, prec: 0.5, rings: [[0.66, 60, 20], [0.80, -50, 50], [0.94, 25, -60]], parts: 6, c: "#FFE36B" },
  sad: { R: 0.26, d: 0.05, n: 3, m: 2, spike: 0, spin: 0.12, prec: 0.08, rings: [[0.64, 74, 8], [0.74, 80, -6], [0, 80, 0]], parts: 1, c: "#6F95E8", dy: 0.14, a: 0.75 },
  angry: { R: 0.28, d: 0, n: 3, m: 2, spike: 0.5, spin: 1.2, prec: 0.9, rings: [[0.50, 60, 30], [0.56, -50, -20], [0.62, 10, 80]], parts: 2, c: "#FF4B5C" },
  surprised: { R: 0.40, d: 0.03, n: 3, m: 2, spike: 0, spin: 0.5, prec: 0.3, rings: [[0.78, 70, 10], [0.88, -60, 40], [0.96, 20, -70]], parts: 4, c: "#FFB86B", burst: 1 },
  love: { R: 0.32, d: 0.12, n: 2, m: 1, spike: 0, spin: 0.35, prec: 0.2, rings: [[0.70, 60, 45], [0.70, 60, -45], [0, 60, 0]], parts: 5, c: "#FF6FD0" },
  confused: { R: 0.30, d: 0.10, n: 5, m: 4, spike: 0, spin: 0.5, prec: 0.6, rings: [[0.60, 30, 80], [0.74, 80, -30], [0.86, -20, 10]], parts: 2, c: "#B99CFF", c2: "#00F0FF", ghost: 1 },
  wink: { R: 0.30, d: 0.04, n: 3, m: 2, spike: 0, spin: 0.3, prec: 0.25, rings: [[0.62, 70, 10], [0.72, -60, 40], [0.86, 0, 0]], parts: 3, c: "#FFE36B" },
};
// Émotion du protocole (28) → jeu de paramètres.
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
const STATE_HALO = { idle: 0.45, listening: 0.9, thinking: 0.7, speaking: 0.8, sleep: 0.15 };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const VS = `#version 300 es
precision highp float;
const float SHADE = 2.0;   // le point est plus grand que son trait : la place pour l'ombre
uniform float uT, uR, uD, uN, uM, uSpike, uSx, uSy, uRy, uParts, uPulse, uListen, uBurst, uGhost, uLevel;
uniform float uScale, uBob, uYaw, uPitch, uPx, uAlpha, uDy;
uniform vec3 uRings[3];
uniform vec2 uAsp;
out float vA; out float vW; flat out int vKind;
const float PI = 3.14159265, TAU = 6.2831853;
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }
vec3 spherePt(int i) {
  int c = i / ${S}; float u = float(i - c * ${S}) / ${S}.0;
  float phi, lam;
  if (c < 5) { phi = -PI / 2.0 + float(c + 1) * PI / 6.0; lam = u * TAU; }
  else { lam = float(c - 5) * PI / 6.0; phi = -PI / 2.0 + u * TAU; }
  float r = uR * (1.0 + (uD + uLevel * 0.22) * sin(uN * phi * 2.0 + 0.7 + uT * 1.3) * cos(uM * lam + uT * 0.7)
    + uSpike * pow(abs(sin(6.0 * lam + uT * 0.8) * sin(6.0 * phi)), 3.0));
  return rotY(rotX(r * vec3(cos(phi) * cos(lam), sin(phi), cos(phi) * sin(lam)), uSx), uSy);
}
vec3 ringPt(int g, float a) {
  vec3 R = uRings[g];
  float tx = R.y + sin(uT * 0.5 + float(g) * 2.1) * 0.12;
  return rotY(rotZ(rotX(vec3(R.x * cos(a), 0.0, R.x * sin(a)), tx), R.z), uRy);
}
void main() {
  int id = gl_VertexID;
  vec3 p = vec3(0.0); float a = 1.0, w = 1.0; int kind = 0; bool flat2d = false;
  if (id < ${N_SPH}) { p = spherePt(id); w = 0.9; }
  else if ((id -= ${N_SPH}) < ${N_SPH}) { p = spherePt(id) + vec3(0.05, 0.0, 0.0); a = uGhost * 0.8; w = 0.8; kind = 1; }
  else if ((id -= ${N_SPH}) < ${N_RING}) {
    int g = id / ${RS}; p = ringPt(g, float(id - g * ${RS}) / ${RS}.0 * TAU); a = step(0.01, uRings[g].x); w = 1.25; kind = 2;
  }
  else if ((id -= ${N_RING}) < ${N_PART}) {
    int g = id / ${PJ * PK}; int r = id - g * ${PJ * PK}; int j = r / ${PK}; int k = r - j * ${PK};
    float tr = 1.0 - float(k) / ${PK}.0;
    float an = (float(j) / max(uParts, 1.0) + float(g) * 0.13) * TAU + uT * (1.1 + float(g) * 0.35) - float(k) * 0.035;
    p = ringPt(g, an); a = step(float(j) + 0.5, uParts) * step(0.01, uRings[g].x) * tr * tr; w = mix(0.8, 2.6, tr); kind = 3;
  }
  else if ((id -= ${N_PART}) < ${N_PULSE}) {
    int g = id / 180; float k = fract(uT * 0.7 + float(g) * 0.5); float an = float(id - g * 180) / 180.0 * TAU;
    p = vec3(cos(an), sin(an), 0.0) * (0.46 + 0.34 * k + uLevel * 0.06); a = (1.0 - k) * uPulse * 0.7; w = 0.8; flat2d = true;
  }
  else if ((id -= ${N_PULSE}) < ${N_LISTEN}) {
    int g = id / 120; float an = mix(232.0, 308.0, float(id - g * 120) / 119.0) * PI / 180.0;
    float k = fract(uT * 0.6 + float(g) / 3.0); float r = 0.80 - 0.36 * k;
    p = vec3(cos(an) * r, 1.12 + sin(an) * r, 0.0); a = sin(k * PI) * uListen * 0.9; w = 0.9; flat2d = true;
  }
  else {
    id -= ${N_LISTEN}; int g = id / 10; float an = float(g) * TAU / 16.0;
    float r = 0.54 + 0.16 * fract(uT * 1.2 + float(id - g * 10) / 10.0);
    p = vec3(cos(an) * r, sin(an) * r, 0.0); a = uBurst * 0.8 * (1.0 - (r - 0.54) / 0.16); w = 1.0; flat2d = true;
  }
  p *= uScale;
  if (!flat2d) p = rotX(rotY(p, uYaw), uPitch);
  p.y += uBob + uDy;
  float persp = 3.2 / (3.2 - p.z);
  vec2 xy = p.xy * persp * 0.92;
  gl_Position = vec4(xy.x * uAsp.x, -xy.y * uAsp.y, 0.0, 1.0);
  // Devant : net et brillant ; derrière : pâle.
  float front = flat2d ? 1.0 : mix(0.22, 1.0, smoothstep(-0.12, 0.12, p.z));
  gl_PointSize = (uPx * w * persp) * SHADE;
  vA = a * front * uAlpha;
  vW = w;
  vKind = kind;
}`;
const FS = `#version 300 es
precision highp float;
const float SHADE = 2.0;
uniform vec3 uCol, uCol2;
in float vA; in float vW; flat in int vKind; out vec4 o;
void main() {
  float d0 = length(gl_PointCoord * 2.0 - 1.0);
  if (d0 > 1.0) discard;
  // L'ombre : une tache sombre et douce, plus large que le trait (elle assombrit un fond clair, elle ne se voit pas sur un fond sombre).
  float shade = exp(-d0 * d0 * 4.0) * (1.0 - smoothstep(0.6, 1.0, d0)) * vA * 0.07;
  float d = d0 * SHADE;
  if (vA <= 0.001) discard;
  float g = exp(-d * d * 3.0), core = exp(-d * d * 14.0);
  vec3 base = vKind == 1 ? uCol2 : uCol;
  float inL = step(d, 1.0);
  // Le trait : sa couleur, bien opaque (elle reste vive sur un fond clair), avec un petit cœur clair (néon sur fond sombre).
  vec3 c = (base * g + core * (vKind >= 2 ? 0.35 : 0.2)) * inL * vA;
  float la = g * inL * vA * 2.2;
  // L'ombre : la même couleur, très foncée, autour du trait. Elle détache le trait d'un fond clair ; sur un fond sombre on ne la voit pas.
  o = vec4(c + base * 0.18 * shade, clamp(max(la, shade), 0.0, 1.0));
}`;
const HVS = `#version 300 es
in vec2 aPos; out vec2 vP; uniform vec2 uAsp;
void main() { vP = aPos / uAsp; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const HFS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o; uniform vec3 uCol; uniform float uK, uDy;
void main() { float R = length(vP); vec2 q = vP + vec2(0.0, uDy); float r = length(q); float h = exp(-r * r * 6.0) * (1.0 - smoothstep(0.6, 0.98, R)) * uK; vec3 hc = uCol * h * 0.3; o = vec4(hc, max(hc.r, max(hc.g, hc.b))); }`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "programme");
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

/** Les valeurs affichées : elles glissent vers celles du jeu de paramètres voulu. */
function snapshot(k) {
  const p = P[k];
  return {
    R: p.R, d: p.d, n: p.n, m: p.m, spike: p.spike, spin: p.spin, prec: p.prec, parts: p.parts,
    rings: p.rings.map(([r, x, z]) => [r, x * D, z * D]), col: rgb(p.c), col2: rgb(p.c2 ?? p.c),
    pulse: p.pulse ?? 0, listen: p.listen ?? 0, burst: p.burst ?? 0, ghost: p.ghost ?? 0, dy: p.dy ?? 0, a: p.a ?? 1,
  };
}

export function create(container, { reducedMotion = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  container.append(canvas);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) throw new Error("WebGL2 indisponible");
  const gyre = program(gl, VS, FS);
  const halo = program(gl, HVS, HFS);
  const emptyVao = gl.createVertexArray();
  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(halo.p, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.enable(gl.BLEND);

  let state = "idle", emotion = "neutral", intensity = 1, until = 0, level = 0, levelS = 0;
  let mood = { valence: 0.2, energy: 0.6 };
  let gaze = { x: 0, y: 0, at: -1e9 };
  const look = { yaw: 0, pitch: 0 };
  let hearing = 0, hearingS = 0;
  let pop = 0, popV = 0, nodAt = -1e9, flashEmo = "", flashUntil = 0;
  const kick = (v) => { if (!reducedMotion) popV += v; };
  const cur = snapshot("idle");
  let t = 0, sx = 20 * D, sy = 30 * D, ry = 20 * D, haloK = STATE_HALO.idle;
  let raf = 0, dead = false, last = performance.now();

  /** Le jeu de paramètres voulu maintenant : veille > émotion > état ; au repos, l'humeur. */
  function wanted(now) {
    if (state === "sleep") return "sleep";
    const e = flashUntil > now ? flashEmo : emotion;
    if (e !== "neutral") { const k = EMO[e] ?? "idle"; return intensity < 0.6 ? MILD[k] ?? k : k; }
    if (state === "listening" || state === "thinking" || state === "speaking") return state;
    if (mood.energy < 0.15) return "sleep";
    if (mood.valence < -0.45) return "sad";
    return "idle";
  }

  function fit() {
    const b = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(b.width * dpr)), h = Math.max(1, Math.round(b.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const m = Math.min(w, h);
    return { asp: [m / w, m / h], px: m * 0.0075 };
  }

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (until && now > until) { emotion = "neutral"; until = 0; }
    const key = wanted(now);
    const tgt = snapshot(key);
    // Ce qui ne se montre pas dans l'état voulu (pulsation, écoute) suit l'état, pas l'émotion.
    if (state === "speaking") tgt.pulse = Math.max(tgt.pulse, 0.7);
    if (state === "listening") tgt.listen = Math.max(tgt.listen, 0.8);
    if (key === "idle") {
      const v = Math.max(-1, Math.min(1, mood.valence));
      tgt.spin *= 0.6 + 0.8 * mood.energy; tgt.prec *= 0.6 + 0.8 * mood.energy;
      for (let c = 0; c < 3; c++) tgt.col[c] += (v > 0 ? [0.25, 0.05, -0.2] : [-0.1, -0.05, 0.1])[c] * Math.abs(v) * 0.5;
    }
    const amp = 0.7 + 0.3 * intensity;
    tgt.d *= amp; tgt.spike *= amp;
    const k = Math.min(1, dt * (reducedMotion ? 6 : 2.6));
    for (const f of ["R", "d", "n", "m", "spike", "spin", "prec", "parts", "pulse", "listen", "burst", "ghost", "dy", "a"]) cur[f] += (tgt[f] - cur[f]) * k;
    for (let g = 0; g < 3; g++) {
      // Un anneau qui disparaît garde sa forme et rétrécit ; un anneau qui apparaît part de sa forme cible.
      const [r, x, z] = tgt.rings[g];
      cur.rings[g][0] += (r - cur.rings[g][0]) * k;
      if (r > 0) { cur.rings[g][1] += (x - cur.rings[g][1]) * k; cur.rings[g][2] += (z - cur.rings[g][2]) * k; }
    }
    for (let c = 0; c < 3; c++) { cur.col[c] += (tgt.col[c] - cur.col[c]) * k; cur.col2[c] += (tgt.col2[c] - cur.col2[c]) * k; }
    levelS += (level - levelS) * Math.min(1, dt * 18);
    hearingS += (hearing - hearingS) * Math.min(1, dt * (hearing > hearingS ? 14 : 4));
    const slow = reducedMotion ? 0.3 : 1;
    t += dt * slow * (1 + (state === "listening" ? hearingS * 0.8 : 0) + (state === "speaking" ? levelS * 0.5 : 0));
    sy += dt * cur.spin * slow; sx = 20 * D + Math.sin(t * 0.21) * 0.25;
    ry += dt * cur.prec * slow;
    const hk = (STATE_HALO[state] ?? 0.45) * (state === "listening" ? 1 + hearingS * 0.5 : 1) * (state === "speaking" ? 0.8 + levelS * 0.6 : 1);
    haloK += (hk - haloK) * Math.min(1, dt * 4);

    const g = now - gaze.at < 5000 ? gaze : { x: 0, y: 0 };
    look.yaw += (g.x * 0.5 - look.yaw) * Math.min(1, dt * 3);
    look.pitch += (-g.y * 0.35 - look.pitch) * Math.min(1, dt * 3);
    const wk = 2 * Math.PI * 2.4;
    popV += (-wk * wk * pop - 2 * 0.45 * wk * popV) * dt;
    pop = Math.max(-0.25, Math.min(0.25, pop + popV * dt));
    const breathe = reducedMotion ? 0 : Math.sin(now / 1000 * (0.9 + mood.energy * 0.7));
    const nodP = (now - nodAt) / 420;
    const nod = nodP >= 0 && nodP < 1 && !reducedMotion ? Math.sin(nodP * Math.PI) * 0.05 : 0;
    const scale = 1 + pop + breathe * 0.012 + (state === "listening" ? hearingS * 0.05 : 0) + (state === "speaking" ? levelS * 0.04 : 0);

    const { asp, px } = fit();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(halo.p);
    gl.bindVertexArray(quadVao);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(halo.u.uAsp, asp[0], asp[1]);
    gl.uniform3f(halo.u.uCol, cur.col[0], cur.col[1], cur.col[2]);
    gl.uniform1f(halo.u.uK, haloK * cur.a);
    gl.uniform1f(halo.u.uDy, -cur.dy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const u = gyre.u;
    gl.useProgram(gyre.p);
    gl.bindVertexArray(emptyVao);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(u.uT, t);
    gl.uniform1f(u.uR, cur.R);
    gl.uniform1f(u.uD, cur.d);
    gl.uniform1f(u.uN, cur.n);
    gl.uniform1f(u.uM, cur.m);
    gl.uniform1f(u.uSpike, cur.spike);
    gl.uniform1f(u.uSx, sx);
    gl.uniform1f(u.uSy, sy);
    gl.uniform1f(u.uRy, ry);
    gl.uniform1f(u.uParts, cur.parts);
    gl.uniform1f(u.uPulse, cur.pulse);
    gl.uniform1f(u.uListen, cur.listen);
    gl.uniform1f(u.uBurst, cur.burst);
    gl.uniform1f(u.uGhost, cur.ghost);
    gl.uniform1f(u.uLevel, state === "speaking" ? levelS : 0);
    gl.uniform1f(u.uScale, scale);
    gl.uniform1f(u.uBob, breathe * 0.01 + nod);
    gl.uniform1f(u.uDy, cur.dy);
    gl.uniform1f(u.uYaw, look.yaw);
    gl.uniform1f(u.uPitch, look.pitch);
    gl.uniform1f(u.uPx, px);
    gl.uniform1f(u.uAlpha, cur.a * 0.6);
    gl.uniform2f(u.uAsp, asp[0], asp[1]);
    gl.uniform3fv(u.uRings, cur.rings.flat());
    gl.uniform3f(u.uCol, cur.col[0], cur.col[1], cur.col[2]);
    gl.uniform3f(u.uCol2, cur.col2[0], cur.col2[1], cur.col2[2]);
    gl.drawArrays(gl.POINTS, 0, TOTAL);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(s) { state = s; },
    setEmotion(name, i, ms) {
      const e = EMO[name] || name === "neutral" ? name : "neutral";
      intensity = Number.isFinite(i) ? i : 1;
      if (e !== emotion && ["joy", "laugh", "excited", "surprised", "shocked", "love", "angry", "scared"].includes(e)) kick(-1.0 * intensity);
      emotion = e;
      until = ms ? performance.now() + ms : 0;
    },
    setLevel(v) { level = Math.max(0, Math.min(1, Number(v) || 0)); },
    setMood(valence, energy) { mood = { valence: Number(valence) || 0, energy: Number.isFinite(energy) ? energy : 0.6 }; },
    lookAt(x, y) {
      const nx = Math.max(-1, Math.min(1, x)), ny = Math.max(-1, Math.min(1, y));
      if (Math.abs(nx - gaze.x) + Math.abs(ny - gaze.y) > 0.02) gaze = { x: nx, y: ny, at: performance.now() };
    },
    setHearing(v) { hearing = Math.max(0, Math.min(1, Number(v) || 0)); },
    cue(name) {
      const now = performance.now();
      if (name === "nod") nodAt = now;
      else if (name === "perk") kick(0.8);
      else if (name === "startle") { kick(1.2); flashEmo = "surprised"; flashUntil = now + 600; }
      else if (name === "poke") { kick(-1.5); flashEmo = "wink"; flashUntil = now + 700; }
    },
    resize() { /* la taille est relue à chaque image */ },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
