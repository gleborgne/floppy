// Avatar « essaim » : un essaim de particules lumineuses en mouvement perpétuel, sans visage la plupart du temps.
// Tout est calculé par le GPU (WebGL2) : le vertex shader place chaque particule à partir d'une graine et du temps.
// Il n'y a aucun état par particule côté JS : 1 seul appel de dessin par image, fluide même avec beaucoup de points.
// - Chaque état (repos, écoute, réflexion…) est un « champ de mouvement » : tore, entonnoir, orbites, fontaine…
// - Un changement d'état ne saute pas : chaque particule glisse d'un champ à l'autre, avec un petit décalage.
// - Les traînées : chaque particule est dessinée K fois, un peu plus tôt dans le temps, de plus en plus petite.
// - Parfois, une partie de l'essaim forme un visage (joie, amour, clin d'œil, surprise, un clic, ou au hasard
//   au repos), puis repart.
// Vivant : humeur au repos, regard (l'essaim penche vers la souris), oreille (l'écoute s'anime avec la voix
// entendue), voix (l'essaim pulse en parlant), ressort (tassement puis rebond), hochement, sursaut.

const N = 900;    // particules (moins nombreuses, mais plus grosses)
const K = 7;      // points par traînée
const FACE_MAX = 64;

const FLOW = { idle: 0, listening: 1, thinking: 2, speaking: 3, sleep: 4, happy: 5, sad: 6, angry: 7, surprised: 8, love: 9, confused: 10 };
// Émotion du protocole (28) → champ de mouvement.
const EMO_FLOW = {
  happy: "happy", joy: "happy", laugh: "happy", excited: "happy", proud: "happy", relieved: "happy",
  love: "love", shy: "love", sad: "sad", cry: "sad", sorry: "sad",
  angry: "angry", annoyed: "angry", determined: "angry",
  surprised: "surprised", shocked: "surprised", scared: "surprised",
  confused: "confused", skeptical: "confused", wink: "idle", mischief: "idle",
  sleepy: "sleep", tired: "sleep", bored: "sleep", thinking: "thinking", curious: "thinking", focused: "thinking",
};
/** Émotion légère (intensité < 0.6) : une version plus douce. */
const MILD = { angry: "confused", surprised: "idle", love: "happy" };
// Émotions qui font apparaître un visage (et lequel).
const FACE_EMO = { happy: "happy", joy: "happy", laugh: "happy", excited: "happy", love: "love", shy: "love", wink: "wink", mischief: "wink", surprised: "surprised", shocked: "surprised" };
// Par champ : couleur, vitesse du temps, durée d'une traînée, luminosité.
const LOOK = {
  idle: { c: "#7CF7FF", speed: 1, trail: 0.012, a: 1 },
  listening: { c: "#5CFFB0", speed: 1, trail: 0.012, a: 1 },
  thinking: { c: "#B98CFF", speed: 1, trail: 0.014, a: 1 },
  speaking: { c: "#7CF7FF", speed: 1, trail: 0.012, a: 1 },
  sleep: { c: "#5866C8", speed: 0.35, trail: 0.03, a: 0.55 },
  happy: { c: "#FFE45C", speed: 1, trail: 0.012, a: 1.1 },
  sad: { c: "#6FA0FF", speed: 0.7, trail: 0.02, a: 0.75 },
  angry: { c: "#FF4D5E", speed: 1, trail: 0.0025, a: 1.1 },
  surprised: { c: "#FFB347", speed: 1, trail: 0.01, a: 1.1 },
  love: { c: "#FF5CCB", speed: 1, trail: 0.02, a: 1.1 },
  confused: { c: "#B98CFF", speed: 1, trail: 0.014, a: 1 },
};
const STATE_HALO = { idle: 0.45, listening: 0.95, thinking: 0.7, speaking: 0.8, sleep: 0.18 };

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Visages (coordonnées : 1 = demi-côté de la zone, y vers le bas).
const q = (x0, y0, cx, cy, x1, y1, n) => { const o = []; for (let i = 0; i < n; i++) { const t = i / (n - 1), u = 1 - t; o.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]); } return o; };
const circ = (cx, cy, r, n) => { const o = [[cx, cy]]; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return o; };
const FACES = {
  idle: () => [...circ(-0.2, -0.1, 0.06, 7), ...circ(0.2, -0.1, 0.06, 7), ...q(-0.14, 0.22, 0, 0.3, 0.14, 0.22, 7)],
  happy: () => [...q(-0.3, -0.04, -0.2, -0.18, -0.1, -0.04, 8), ...q(0.1, -0.04, 0.2, -0.18, 0.3, -0.04, 8), ...q(-0.2, 0.16, 0, 0.44, 0.2, 0.16, 12)],
  wink: () => [...circ(-0.2, -0.1, 0.06, 7), ...q(0.1, -0.06, 0.2, -0.14, 0.3, -0.06, 7), ...q(-0.14, 0.18, 0, 0.34, 0.14, 0.2, 8)],
  surprised: () => [...circ(-0.2, -0.12, 0.09, 10), ...circ(0.2, -0.12, 0.09, 10), ...circ(0, 0.3, 0.08, 9)],
  love: () => {
    const heart = (cx) => { const o = []; for (let i = 0; i < 12; i++) { const t = i / 12 * Math.PI * 2; o.push([cx + 0.0055 * 16 * Math.sin(t) ** 3, -0.1 - 0.0055 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]); } return o; };
    return [...heart(-0.2), ...heart(0.2), ...q(-0.14, 0.2, 0, 0.36, 0.14, 0.2, 8)];
  },
};

const VS = `#version 300 es
precision highp float;
const float SHADE = 2.0;   // le point est plus grand que son trait : la place pour l'ombre
uniform float uT, uTrail, uBlend, uLevel, uScale, uBob, uYaw, uPitch, uPx, uAlpha, uFaceK, uHear;
uniform int uFA, uFB, uFaceN;
uniform vec2 uAsp, uFace[${FACE_MAX}];
out float vA; out float vFace;
const float TAU = 6.2831853;
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z); }
vec3 hash3(uint n) {
  n = (n << 13u) ^ n; n = n * (n * n * 15731u + 789221u) + 1376312589u;
  uvec3 k = n * uvec3(n, n * 16807u, n * 48271u);
  return vec3((k >> 8u) & uvec3(0x7fffffu)) / float(0x7fffff);
}
vec3 sph(float b, float c) { float th = b * TAU, ph = acos(2.0 * c - 1.0); return vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th)); }
float life(float k) { return smoothstep(0.0, 0.08, k) * smoothstep(1.0, 0.9, k); }
// Champs de mouvement : position (xyz) et visibilité (w) d'une particule de graine s au temps t.
vec4 flow(int f, vec3 s, float t, int id) {
  float m = float(id % 2);
  if (f == 0) {   // repos : un atome. Un noyau qui frémit, et 3 électrons qui tournent sur 3 orbites inclinées.
    int g = id % 5;
    if (g == 0) { float r = 0.17 * pow(s.x, 0.333); return vec4(rotY(sph(s.y, s.z) * r, t * 0.9) + 0.012 * vec3(sin(t * 7.0 + s.x * 40.0), cos(t * 6.0 + s.y * 40.0), 0.0), 1.0); }
    float o = float((id / 5) % 3);
    float e = t * (1.5 + 0.25 * o) + o * 2.1;                       // position de l'électron sur son orbite
    bool cloud = s.z < 0.6;                                         // 60 % en grappe autour de l'électron, le reste trace l'orbite
    float an = cloud ? e - pow(s.x, 1.6) * 1.1 : s.x * TAU + t * 0.3;
    vec3 q = vec3(0.74 * cos(an), (s.y - 0.5) * (cloud ? 0.05 : 0.015), 0.74 * sin(an));
    q = rotZ(rotY(rotX(q, 0.38), t * 0.25), o * 1.0472 + 0.3);
    return vec4(q, cloud ? 1.0 - s.x * 0.5 : 0.35); }
  if (f == 1) { float k = fract(s.x + t * (0.4 + uHear * 0.5)); float r = 0.74 * (1.0 - k) + 0.05; float an = s.y * TAU + t * 2.0 + k * 5.0;
    return vec4(r * cos(an), -0.62 + k * 1.36, r * sin(an) * 0.45, life(k)); }
  if (f == 2) { float an = s.x * TAU + t * mix(-2.4, 3.0, m); float r = mix(0.76, 0.60, m);
    return vec4(rotZ(rotX(vec3(r * cos(an), (s.z - 0.5) * 0.05, r * sin(an)), mix(1.08, 1.31, m)), mix(-0.49, 0.49, m)), 1.0); }
  if (f == 3) { float k = fract(s.x + t * 0.8); float r = 0.30 + (0.40 + uLevel * 0.35) * k; return vec4(sph(s.y, s.z) * r, life(k)); }
  if (f == 4) { return vec4(-0.74 + s.x * 1.48 + sin(t * 0.5 + s.z * 9.0) * 0.02, 0.78 - s.y * s.y * 0.2, (s.z - 0.5) * 0.5, 1.0); }
  if (f == 5) { float k = fract(s.x + t * 0.5); return vec4((s.y - 0.5) * 1.2 * k, 0.70 - 1.9 * k + 1.6 * k * k, (s.z - 0.5) * 0.5, life(k)); }
  if (f == 6) { float k = fract(s.y + t * 0.18); return vec4(-0.66 + s.x * 1.32 + sin(t + s.y * 7.0) * 0.03, -0.46 + k * 1.36, (s.z - 0.5) * 0.4, life(k)); }
  if (f == 7) { float r = 0.5 * pow(s.x, 0.333); return vec4(sph(s.y, s.z) * r + vec3(0.06 * sin(t * 22.0 + s.x * 50.0), 0.06 * cos(t * 19.0 + s.y * 40.0), 0.0), 1.0); }
  if (f == 8) { float k = fract(s.x + t); return vec4(sph(s.y, s.z) * (0.18 + 0.82 * k), life(k)); }
  if (f == 9) { float a = fract(s.x + t * 0.15) * TAU, n = (s.y - 0.5) * 0.12;
    float hx = 16.0 * pow(sin(a), 3.0), hy = -(13.0 * cos(a) - 5.0 * cos(2.0 * a) - 2.0 * cos(3.0 * a) - cos(4.0 * a));
    return vec4(0.048 * hx + n, 0.048 * hy - 0.06 + n * 0.6, (s.z - 0.5) * 0.3, 1.0); }
  float an = s.x * TAU + t * mix(-2.2, 2.2, m); float r = 0.08 + s.y * 0.34;
  return vec4(mix(-0.34, 0.34, m) + r * cos(an), r * sin(an) * 0.9, (s.z - 0.5) * 0.3, 1.0);
}
void main() {
  int id = gl_VertexID / ${K}; int k = gl_VertexID - id * ${K};
  vec3 s = hash3(uint(id) + 17u);
  float tk = uT - float(k) * uTrail;
  vec4 P = mix(flow(uFA, s, tk, id), flow(uFB, s, tk, id), smoothstep(0.0, 1.0, clamp(uBlend * 1.6 - s.z * 0.6, 0.0, 1.0)));
  float fm = 0.0;
  if (id < uFaceN) {
    fm = smoothstep(0.0, 1.0, clamp(uFaceK * 1.5 - s.x * 0.5, 0.0, 1.0));
    P = mix(P, vec4(uFace[id], 0.3, 1.0), fm);
  }
  P.xyz *= uScale * (1.0 + uLevel * 0.10 * sin(uT * 9.0 + s.x * 20.0));
  P.xyz = rotX(rotY(P.xyz, uYaw), uPitch);
  P.y += uBob;
  float persp = 3.2 / (3.2 - P.z);
  vec2 xy = P.xy * persp * 0.9;
  gl_Position = vec4(xy.x * uAsp.x, -xy.y * uAsp.y, 0.0, 1.0);
  float tr = 1.0 - float(k) / ${K}.0;
  gl_PointSize = (uPx * (0.6 + 0.9 * s.y) * mix(0.35, 1.0, tr) * persp * (1.0 + fm * 0.7)) * SHADE;
  vA = P.w * tr * tr * clamp(0.55 + P.z * 0.6, 0.15, 1.2) * uAlpha * mix(1.0, 1.6, fm);
  vFace = fm;
}`;
const FS = `#version 300 es
precision highp float;
const float SHADE = 2.0;
uniform vec3 uCol;
in float vA; in float vFace; out vec4 o;
void main() {
  float d0 = length(gl_PointCoord * 2.0 - 1.0);
  if (d0 > 1.0) discard;
  // L'ombre : une tache sombre et douce, plus large que le trait (elle assombrit un fond clair, elle ne se voit pas sur un fond sombre).
  float shade = exp(-d0 * d0 * 4.0) * (1.0 - smoothstep(0.6, 1.0, d0)) * vA * 0.10;
  float d = d0 * SHADE;
  float g = exp(-d * d * 3.5), core = exp(-d * d * 16.0);
  vec3 base = mix(uCol, vec3(1.0), vFace * 0.45);
  float inL = step(d, 1.0);
  // Le trait : sa couleur, bien opaque (elle reste vive sur un fond clair), avec un petit cœur clair (néon sur fond sombre).
  vec3 c = (base * g + core * 0.3) * inL * vA;
  float la = g * inL * vA * 2.2;
  // L'ombre : la même couleur, très foncée, autour du trait. Elle détache le trait d'un fond clair ; sur un fond sombre on ne la voit pas.
  o = vec4(c + base * 0.18 * shade, clamp(max(la, shade), 0.0, 1.0));
}`;
// Halo doux derrière l'essaim. Il s'éteint avant le bord de la zone (sinon un carré se voit sur le bureau).
const HVS = `#version 300 es
in vec2 aPos; out vec2 vP; uniform vec2 uAsp;
void main() { vP = aPos / uAsp; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const HFS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o; uniform vec3 uCol; uniform float uK;
void main() { float R = length(vP); vec2 q = vP; float r = length(q); float h = exp(-r * r * 6.0) * (1.0 - smoothstep(0.6, 0.98, R)) * uK; vec3 hc = uCol * h * 0.3; o = vec4(hc, max(hc.r, max(hc.g, hc.b))); }`;

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

export function create(container, { reducedMotion = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  container.append(canvas);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) throw new Error("WebGL2 indisponible");
  const swarm = program(gl, VS, FS);
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
  // Champs : A → B, avec un mélange qui avance de 0 à 1 ; le suivant attend la fin du mélange.
  let fa = "idle", fb = "idle", blend = 1, next = "";
  const col = rgb(LOOK.idle.c), haloCol = rgb(LOOK.idle.c);
  let t = 0, speed = 1, trail = LOOK.idle.trail, alpha = 1, haloK = STATE_HALO.idle;
  // Visage éphémère.
  let face = "", faceUntil = 0, faceK = 0, nextFace = performance.now() + 20000 + Math.random() * 25000;
  const facePts = new Float32Array(FACE_MAX * 2);
  let faceN = 0;
  const setFace = (name, ms) => {
    if (name !== face) {
      const pts = FACES[name]().slice(0, FACE_MAX);
      facePts.fill(0);
      pts.forEach(([x, y], i) => { facePts[i * 2] = x; facePts[i * 2 + 1] = y; });
      faceN = pts.length;
      face = name;
    }
    faceUntil = performance.now() + ms;
  };
  let raf = 0, dead = false, last = performance.now();

  /** Le champ voulu maintenant : veille > émotion > état ; au repos, l'humeur. */
  function wanted(now) {
    if (state === "sleep") return "sleep";
    let e = flashUntil > now ? flashEmo : emotion;
    if (e !== "neutral") {
      let f = EMO_FLOW[e] ?? "idle";
      if (intensity < 0.6) f = MILD[f] ?? f;
      return f;
    }
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
    return { asp: [m / w, m / h], px: m * 0.017 };
  }

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const ease = (k) => Math.min(1, dt * k);
    if (until && now > until) { emotion = "neutral"; until = 0; }

    // Champ de mouvement.
    const w = wanted(now);
    if (w !== fb) { if (blend >= 1) { fa = fb; fb = w; blend = 0; next = ""; } else next = w; }
    else next = "";
    blend = Math.min(1, blend + dt / (reducedMotion ? 0.4 : 1.1));
    if (blend >= 1 && next && next !== fb) { fa = fb; fb = next; blend = 0; next = ""; }

    // Couleur, vitesse, traînée : elles glissent.
    const L = LOOK[fb];
    const target = rgb(L.c);
    if (fb === "idle") { const v = Math.max(-1, Math.min(1, mood.valence)); for (let c = 0; c < 3; c++) target[c] += (v > 0 ? [0.25, 0.05, -0.2] : [-0.1, -0.05, 0.1])[c] * Math.abs(v) * 0.5; }
    for (let c = 0; c < 3; c++) col[c] += (target[c] - col[c]) * ease(3);
    levelS += (level - levelS) * ease(18);
    hearingS += (hearing - hearingS) * ease(hearing > hearingS ? 14 : 4);
    const energy = fb === "idle" ? 0.6 + 0.8 * mood.energy : 1;
    const wantSpeed = L.speed * energy * (0.75 + 0.35 * intensity) * (reducedMotion ? 0.35 : 1) * (state === "speaking" ? 1 + levelS * 0.6 : 1);
    speed += (wantSpeed - speed) * ease(2);
    trail += (L.trail - trail) * ease(3);
    alpha += (L.a * (fb === "listening" ? 1 + hearingS * 0.4 : 1) - alpha) * ease(3);
    t += dt * speed;
    const hk = (STATE_HALO[state] ?? 0.45) * (state === "listening" ? 1 + hearingS * 0.5 : 1) * (state === "speaking" ? 0.8 + levelS * 0.6 : 1);
    haloK += (hk - haloK) * ease(4);
    for (let c = 0; c < 3; c++) haloCol[c] += (col[c] - haloCol[c]) * ease(4);

    // Visage : parfois (au repos, au hasard).
    if (state === "idle" && emotion === "neutral" && now > nextFace && !reducedMotion) { setFace("idle", 1800); nextFace = now + 25000 + Math.random() * 30000; }
    const showFace = faceUntil > now && state !== "sleep";
    faceK += ((showFace ? 1 : 0) - faceK) * ease(showFace ? 2.2 : 1.6);

    // Regard, ressort, respiration, hochement.
    const g = now - gaze.at < 5000 ? gaze : { x: 0, y: 0 };
    look.yaw += (g.x * 0.45 - look.yaw) * ease(3);
    look.pitch += (-g.y * 0.3 - look.pitch) * ease(3);
    const wk = 2 * Math.PI * 2.4;
    popV += (-wk * wk * pop - 2 * 0.45 * wk * popV) * dt;
    pop = Math.max(-0.25, Math.min(0.25, pop + popV * dt));
    const breathe = reducedMotion ? 0 : Math.sin(now / 1000 * (0.9 + mood.energy * 0.7));
    const nodP = (now - nodAt) / 420;
    const nod = nodP >= 0 && nodP < 1 && !reducedMotion ? Math.sin(nodP * Math.PI) * 0.05 : 0;
    const scale = 1 + pop + breathe * 0.015 + (state === "listening" ? hearingS * 0.06 : 0);

    const { asp, px } = fit();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Halo.
    gl.useProgram(halo.p);
    gl.bindVertexArray(quadVao);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(halo.u.uAsp, asp[0], asp[1]);
    gl.uniform3f(halo.u.uCol, haloCol[0], haloCol[1], haloCol[2]);
    gl.uniform1f(halo.u.uK, haloK);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Essaim (additif : les points s'éclairent entre eux).
    const u = swarm.u;
    gl.useProgram(swarm.p);
    gl.bindVertexArray(emptyVao);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1f(u.uT, t);
    gl.uniform1f(u.uTrail, trail);
    gl.uniform1f(u.uBlend, blend);
    gl.uniform1i(u.uFA, FLOW[fa]);
    gl.uniform1i(u.uFB, FLOW[fb]);
    gl.uniform1f(u.uLevel, state === "speaking" ? levelS : 0);
    gl.uniform1f(u.uHear, hearingS);
    gl.uniform1f(u.uScale, scale);
    gl.uniform1f(u.uBob, breathe * 0.01 + nod);
    gl.uniform1f(u.uYaw, look.yaw);
    gl.uniform1f(u.uPitch, look.pitch);
    gl.uniform1f(u.uPx, px);
    gl.uniform1f(u.uAlpha, alpha * 0.55);
    gl.uniform2f(u.uAsp, asp[0], asp[1]);
    gl.uniform3f(u.uCol, col[0], col[1], col[2]);
    gl.uniform1f(u.uFaceK, faceK);
    gl.uniform1i(u.uFaceN, faceN);
    gl.uniform2fv(u.uFace, facePts);
    gl.drawArrays(gl.POINTS, 0, N * K);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(s) { state = s; },
    setEmotion(name, i, ms) {
      const e = EMO_FLOW[name] || name === "neutral" ? name : "neutral";
      intensity = Number.isFinite(i) ? i : 1;
      if (e !== emotion && ["joy", "laugh", "excited", "surprised", "shocked", "love", "angry", "scared"].includes(e)) kick(-1.0 * intensity);
      emotion = e;
      until = ms ? performance.now() + ms : 0;
      // Le visage : un instant seulement.
      if (FACE_EMO[e] && intensity >= 0.5) setFace(FACE_EMO[e], Math.min(ms || 1800, 1800));
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
      else if (name === "poke") { kick(-1.5); setFace("happy", 900); }
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
