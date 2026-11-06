// Avatar « pixel » : un rond jaune avec un visage en points lumineux (panneau de LED rondes), dessiné en WebGL.
// - Le visage est une grille de 16 x 16 points. Chaque émotion allume des points (encre, rose, bleu).
// - Les points ne sautent pas : chacun glisse vers sa nouvelle valeur, avec une petite vague depuis le centre.
// - Le shader dessine le corps (ombre douce, reflet, liseré), les points (ronds, nets à toute taille, faible relief
//   des points éteints), un halo dont la couleur suit l'état (écoute, réflexion, parole) et une respiration.
// 12 émotions dessinées ; les 16 autres du protocole prennent la plus proche (NEAREST).
// Vivant : humeur au repos (content, triste, endormi), regard qui suit la souris, oreille qui réagit à la voix
// entendue, hochement, sursaut et réaction au clic (le rond se tasse puis rebondit, comme un ressort).

const N = 16;                         // grille N x N, centre (0, 0), y vers le bas, cases de -8 à 7
const NEAREST = {
  laugh: "joy", excited: "joy", proud: "happy", cry: "sad", annoyed: "angry", shocked: "surprised",
  skeptical: "confused", mischief: "wink", shy: "happy", bored: "sleepy", tired: "sleepy", curious: "thinking",
  focused: "thinking", sorry: "sad", relieved: "happy", determined: "angry",
};

// Formes (en cases) : yeux de l'œil gauche (le droit est le miroir, sauf `right`), bouche, accents.
const r = (x, y, w, h) => [x, y, w, h];
const EMO = {
  neutral: { eyes: [r(-4, -3, 2, 3)], mouth: [r(-2, 3, 4, 1)] },
  happy: { eyes: [r(-5, -2, 1, 1), r(-4, -3, 2, 1), r(-2, -2, 1, 1)], mouth: [r(-3, 2, 1, 1), r(-2, 3, 4, 1), r(2, 2, 1, 1)] },
  joy: { eyes: [r(-5, -2, 1, 1), r(-4, -3, 2, 1), r(-2, -2, 1, 1)], mouth: [r(-3, 2, 6, 1), r(-2, 3, 4, 2)], cheeks: true },
  sad: { eyes: [r(-4, -3, 2, 3), r(-5, -4, 1, 1)], mouth: [r(-2, 3, 4, 1), r(-3, 4, 1, 1), r(2, 4, 1, 1)], tear: true },
  angry: { eyes: [r(-5, -4, 1, 1), r(-4, -3, 2, 1), r(-2, -2, 1, 1), r(-4, -2, 2, 2)], mouth: [r(-3, 4, 6, 1), r(-3, 3, 1, 1), r(2, 3, 1, 1)], cheeks: true, hot: true },
  surprised: { eyes: [r(-5, -4, 3, 4)], mouth: [r(-1, 3, 2, 3)] },
  love: { eyes: [r(-5, -4, 2, 1), r(-2, -4, 1, 1), r(-5, -3, 4, 2), r(-4, -1, 2, 1)], pinkEyes: true, mouth: [r(-2, 3, 4, 1), r(-1, 4, 2, 1)], cheeks: true },
  sleepy: { eyes: [r(-5, -1, 3, 1)], mouth: [r(-1, 3, 2, 1)], zzz: true },
  thinking: { eyes: [r(-4, -4, 2, 3)], look: [2, -1], mouth: [r(-1, 3, 3, 1)], dots: true },
  wink: { eyes: [r(-4, -3, 2, 3)], right: [r(2, -2, 3, 1)], mouth: [r(-3, 2, 1, 1), r(-2, 3, 4, 1), r(2, 2, 1, 1)] },
  scared: { eyes: [r(-5, -4, 3, 4)], pupils: true, mouth: [r(-3, 4, 1, 1), r(-2, 3, 1, 1), r(-1, 4, 1, 1), r(0, 3, 1, 1), r(1, 4, 1, 1), r(2, 3, 1, 1)], sweat: true },
  confused: { eyes: [r(-4, -3, 2, 3)], right: [r(2, -4, 3, 4)], mouth: [r(-3, 4, 2, 1), r(-1, 3, 2, 1), r(1, 4, 2, 1)], mark: true },
};
export const EMOTIONS = Object.keys(EMO);
/** Émotion légère (intensité < 0.6) : une version plus douce. */
const MILD = { joy: "happy", angry: "confused", scared: "surprised", love: "happy" };

// Halo selon l'état (rgb 0..1) et intensité.
const HALO = {
  idle: [[1.0, 0.82, 0.42], 0.45], listening: [[0.35, 0.95, 0.75], 0.95], thinking: [[1.0, 0.68, 0.25], 0.75],
  speaking: [[0.45, 0.75, 1.0], 0.8], sleep: [[0.55, 0.6, 0.75], 0.18],
};

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uRes;
uniform sampler2D uDots;       // 16 x 16 : r = encre, g = rose, b = bleu
uniform float uTime, uScale, uBob, uDim, uTilt;
uniform vec3 uHalo; uniform float uHaloK;
const float N = ${N}.0;
const vec3 BODY = vec3(0.953, 0.812, 0.420);
const vec3 BODY_DARK = vec3(0.86, 0.62, 0.24);
const vec3 INK = vec3(0.165, 0.141, 0.071);
const vec3 PINK = vec3(1.0, 0.42, 0.62);
const vec3 BLUE = vec3(0.40, 0.70, 1.0);
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() {
  vec2 p = (vUv * uRes - 0.5 * uRes) / min(uRes.x, uRes.y);   // -0.5..0.5 sur le petit côté
  p.y = -p.y;                                                 // y vers le bas, comme la grille
  p.y -= uBob;
  p = rot(uTilt) * p;
  float R = 0.40 * uScale;
  float d = length(p) - R;
  float px = fwidth(d);
  // Halo et ombre portée (dehors).
  // Le halo s'éteint avant le bord de la zone de dessin (sinon un carré se voit sur le bureau).
  float halo = exp(-max(d, 0.0) * 16.0) * uHaloK * (0.85 + 0.15 * sin(uTime * 2.0)) * smoothstep(0.49, 0.36, length(p));
  vec2 sp = p - vec2(0.0, 0.035 * uScale);
  float shadow = (1.0 - smoothstep(-0.02, 0.10, length(sp) - R)) * 0.45;
  vec3 col = vec3(0.0);
  float a = 0.0;
  // Halo surtout additif (il éclaire sans assombrir le fond).
  col += uHalo * halo; a += halo * 0.35;
  a = max(a, shadow * (1.0 - step(0.0, -d)));
  // Corps.
  float inside = 1.0 - smoothstep(-px, px, d);
  if (inside > 0.0) {
    vec2 q = p / R;                                           // -1..1 dans le disque
    float light = clamp(0.62 - 0.38 * q.y - 0.22 * q.x, 0.0, 1.0);
    vec3 body = mix(BODY_DARK, BODY, smoothstep(0.0, 1.0, light + 0.15));
    float rim = smoothstep(0.80, 1.0, length(q)) * smoothstep(0.2, -0.6, q.y + q.x * 0.5);
    body += rim * vec3(0.35, 0.25, 0.10);
    float spec = exp(-pow(length(q - vec2(-0.38, -0.46)) / 0.22, 2.0)) * 0.30;
    body += spec;
    // Points : grille de N x N sur 0.86 du diamètre.
    float cellSize = (2.0 * R * 0.86) / N;
    vec2 g = p / cellSize + N * 0.5;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float dotPx = fwidth(g.x);
    vec3 dots = vec3(0.0);
    if (cell.x >= 0.0 && cell.y >= 0.0 && cell.x < N && cell.y < N) dots = texture(uDots, (cell + 0.5) / N).rgb;
    float dr = length(f);
    float lit = max(max(dots.r, dots.g), dots.b);
    float rad = mix(0.30, 0.43, lit);
    float disc = 1.0 - smoothstep(rad - dotPx, rad + dotPx, dr);
    // Point éteint : petit creux à peine visible (texture de panneau), seulement loin du bord.
    float edge = smoothstep(0.98, 0.80, length(q));
    float dimple = (1.0 - smoothstep(0.26 - dotPx, 0.26 + dotPx, dr)) * 0.07 * edge;
    body = mix(body, body * 0.80, dimple);
    // Encre (sombre) et accents (colorés, avec un léger rayonnement).
    vec3 inkCol = mix(INK, INK * 1.8, 0.25 - f.y * 0.5);
    body = mix(body, inkCol, disc * dots.r);
    vec3 acc = PINK * dots.g + BLUE * dots.b;
    float accK = max(dots.g, dots.b);
    body = mix(body, acc * 1.05, disc * accK);
    float glow = exp(-dr * dr * 9.0) * accK * 0.35;
    body += acc * glow;
    body *= mix(1.0, 0.72, uDim);
    col = mix(col, body, inside);
    a = mix(a, 1.0, inside);
  }
  o = vec4(col * (a > 0.0 ? 1.0 : 0.0), a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export function create(container, { reducedMotion = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  container.append(canvas);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true });
  if (!gl) throw new Error("WebGL2 indisponible");
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "programme");
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const U = Object.fromEntries(["uRes", "uDots", "uTime", "uScale", "uBob", "uDim", "uTilt", "uHalo", "uHaloK"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  gl.uniform1i(U.uDots, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // État : cible (ce que l'expression demande) et courant (ce qui est affiché), 3 canaux par point.
  const target = new Float32Array(N * N * 3);
  const cur = new Float32Array(N * N * 3);
  const bytes = new Uint8Array(N * N * 4);
  // Retard de chaque point (vague depuis le centre), relancé à chaque changement d'expression.
  const delay = new Float32Array(N * N);
  let waveAt = 0;
  let state = "idle", emotion = "neutral", until = 0, level = 0, levelS = 0;
  let mood = { valence: 0.2, energy: 0.6 };
  let gaze = { x: 0, y: 0, at: -1e9 };
  let hearing = 0, hearingS = 0;
  // Ressort sur la taille : tassement puis rebond (élan, clic, sursaut).
  let pop = 0, popV = 0;
  let nodAt = -1e9, flashEmo = "", flashUntil = 0;
  const kick = (v) => { if (!reducedMotion) popV += v; };
  let nextBlink = performance.now() + 2500, blinkAt = 0;
  const halo = { rgb: [...HALO.idle[0]], k: HALO.idle[1] };
  let raf = 0, dead = false, last = performance.now();
  const look = [0, 0];

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) delay[y * N + x] = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5) * 0.018;

  const set = (gx, gy, ch, v = 1) => {
    const x = gx + N / 2, y = gy + N / 2;
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 3 + ch;
    target[i] = Math.max(target[i], v);
  };
  const clear = (gx, gy) => { const x = gx + N / 2, y = gy + N / 2; if (x >= 0 && y >= 0 && x < N && y < N) target.fill(0, (y * N + x) * 3, (y * N + x) * 3 + 3); };
  const fill = (list, ch, mirror = false, dx = 0, dy = 0, onlyBottom = false) => {
    for (const [x, y, w, h] of list) {
      const gx = mirror ? -x - w : x;
      for (let j = onlyBottom ? h - 1 : 0; j < h; j++) for (let i = 0; i < w; i++) set(gx + i + dx, y + j + dy, ch);
    }
  };

  function build(now) {
    target.fill(0);
    const asleep = state === "sleep";
    // Au repos, l'humeur choisit le visage : content, triste, ou il pique du nez.
    let shown = flashUntil > now ? flashEmo : emotion;
    if (shown === "neutral" && state === "idle") shown = mood.energy < 0.2 ? "sleepy" : mood.valence > 0.5 ? "happy" : mood.valence < -0.45 ? "sad" : "neutral";
    const e = asleep ? EMO.sleepy : (EMO[shown] ?? EMO.neutral);
    const t = now / 1000;
    const blinking = !asleep && blinkAt && now - blinkAt < 130;
    const lk = [...(e.look ?? [0, 0])];
    // Regard : il suit la souris quelques secondes après qu'elle a bougé.
    if (!e.look && !asleep && now - gaze.at < 5000 && state !== "thinking") { lk[0] += gaze.x * 1.6; lk[1] += gaze.y * 1.2; }
    look[0] += (lk[0] - look[0]) * 0.15; look[1] += (lk[1] - look[1]) * 0.15;
    const dx = Math.round(look[0]), dy = Math.round(look[1]);
    const eyeCh = e.pinkEyes ? 1 : 0;
    fill(e.eyes, eyeCh, false, dx, dy, blinking);
    fill(e.right ?? e.eyes, eyeCh, !e.right, dx, dy, blinking);
    if (e.pupils && !blinking) { clear(-4 + dx, -2 + dy); clear(3 + dx, -2 + dy); }
    if (e.cheeks) { for (const gx of [-7, -6, 5, 6]) set(gx, 1, 1, e.hot ? 0.75 : 0.85); }
    // Bouche : en parlant, elle s'ouvre avec la voix.
    if (state === "speaking" && !asleep) {
      const open = 1 + levelS * 3.2;
      for (let j = 0; j < 4; j++) { const v = Math.max(0, Math.min(1, open - j)); for (let i = -2; i < 2; i++) set(i, 3 + j, 0, v); }
    } else fill(e.mouth, 0);
    if (e.tear) { const k = (t * 1.6) % 1; set(-5, Math.floor(k * 3), 2, 1 - k * 0.6); set(-5, Math.floor(k * 3) + 1, 2, 0.6 - k * 0.4); }
    if (e.sweat) set(5, -5, 2, 0.6 + 0.4 * Math.sin(t * 3)), set(5, -4, 2, 0.5 + 0.4 * Math.sin(t * 3 + 1));
    if ((state === "thinking" && emotion === "neutral") || e.dots) {
      for (let i = 0; i < 3; i++) set(3 + i * 2, -7, 0, Math.max(0, Math.sin(t * 4 - i * 0.9)) * 0.9);
    }
    if (e.zzz || asleep) {
      const k = (t * 0.6) % 1;
      const zy = Math.round(-5 - k * 2), zx = 4 + Math.round(k);
      for (const [x, y] of [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]]) set(zx + x, zy + y - 1, 0, 0.75 * (1 - k));
    }
    if (e.mark) { for (const [x, y] of [[5, -7], [6, -7], [6, -6], [5, -5], [5, -3]]) set(x, y, 0, 0.9); }
  }

  function fit() {
    const b = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(b.width * dpr)), h = Math.max(1, Math.round(b.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(U.uRes, w, h);
  }

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (until && now > until) { emotion = "neutral"; until = 0; waveAt = now; }
    if (state !== "sleep" && now > nextBlink) { blinkAt = now; nextBlink = now + 2400 + Math.random() * 4200; }
    levelS += (level - levelS) * Math.min(1, dt * 18);
    build(now);
    // Chaque point glisse vers sa cible (plus vite en mouvement réduit, sans vague).
    const since = (now - waveAt) / 1000;
    const speed = reducedMotion ? 30 : 11;
    for (let i = 0; i < N * N; i++) {
      const go = reducedMotion || since > delay[i] ? 1 : 0;
      for (let c = 0; c < 3; c++) {
        const k = i * 3 + c;
        cur[k] += (target[k] - cur[k]) * Math.min(1, dt * speed) * go;
        bytes[i * 4 + c] = Math.round(Math.max(0, Math.min(1, cur[k])) * 255);
      }
      bytes[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    // Halo, respiration, inclinaison.
    const [rgb, k0] = HALO[state] ?? HALO.idle;
    const k = k0 * (state === "sleep" ? 1 : 0.75 + 0.45 * mood.energy) * (state === "listening" ? 1 + hearingS * 0.5 : 1);
    for (let c = 0; c < 3; c++) halo.rgb[c] += (rgb[c] - halo.rgb[c]) * Math.min(1, dt * 4);
    halo.k += (k - halo.k) * Math.min(1, dt * 4);
    const t = now / 1000;
    const breathe = reducedMotion ? 0 : Math.sin(t * (state === "listening" ? 2.6 : 0.9 + mood.energy * 0.7));
    hearingS += (hearing - hearingS) * Math.min(1, dt * (hearing > hearingS ? 14 : 4));
    // Ressort : ω ≈ 2π·2.8 Hz, amorti à 0.5.
    const w = 2 * Math.PI * 2.8;
    popV += (-w * w * pop - 2 * 0.5 * w * popV) * dt;
    pop = Math.max(-0.2, Math.min(0.2, pop + popV * dt));
    const nodP = (now - nodAt) / 420;
    const nod = nodP >= 0 && nodP < 1 && !reducedMotion ? Math.sin(nodP * Math.PI) * 0.018 : 0;
    const scale = (state === "listening" ? 1.04 + hearingS * 0.035 : 1) + breathe * 0.008 + (state === "speaking" ? levelS * 0.025 : 0) + pop;
    const tilt = reducedMotion ? 0 : (emotion === "confused" || emotion === "thinking" ? 0.10 : 0) + Math.sin(t * 0.7) * 0.012;
    fit();
    gl.uniform1f(U.uTime, t);
    gl.uniform1f(U.uScale, scale);
    gl.uniform1f(U.uBob, breathe * 0.006 - nod);
    gl.uniform1f(U.uDim, state === "sleep" ? 1 : 0);
    gl.uniform1f(U.uTilt, tilt);
    gl.uniform3f(U.uHalo, halo.rgb[0], halo.rgb[1], halo.rgb[2]);
    gl.uniform1f(U.uHaloK, halo.k);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(s) { if (s !== state) { state = s; waveAt = performance.now(); } },
    setEmotion(name, intensity, ms) {
      let e = EMO[name] ? name : NEAREST[name] ?? "neutral";
      const i = Number.isFinite(intensity) ? intensity : 1;
      if (i < 0.6) e = MILD[e] ?? e;
      if (e !== emotion) {
        waveAt = performance.now();
        if (["joy", "surprised", "love", "angry", "scared"].includes(e)) kick(-0.9 * i); // tassement, puis rebond
      }
      emotion = e;
      until = ms ? performance.now() + ms : 0;
    },
    setMood(valence, energy) { mood = { valence: Number(valence) || 0, energy: Number.isFinite(energy) ? energy : 0.6 }; },
    lookAt(x, y) {
      const nx = Math.max(-1, Math.min(1, x)), ny = Math.max(-1, Math.min(1, y));
      if (Math.abs(nx - gaze.x) + Math.abs(ny - gaze.y) > 0.02) gaze = { x: nx, y: ny, at: performance.now() };
    },
    setHearing(v) { hearing = Math.max(0, Math.min(1, Number(v) || 0)); },
    cue(name) {
      const now = performance.now();
      if (name === "nod") nodAt = now;
      else if (name === "perk") kick(0.7);
      else if (name === "wake") { kick(1.2); waveAt = now; nodAt = now + 120; }
      else if (name === "startle") { kick(1.1); flashEmo = "surprised"; flashUntil = now + 600; waveAt = now; }
      else if (name === "poke") { kick(-1.4); blinkAt = now; }
    },
    setLevel(v) { level = Math.max(0, Math.min(1, Number(v) || 0)); },
    resize() { /* la taille est relue à chaque image */ },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
