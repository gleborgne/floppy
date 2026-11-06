// Avatar « pixelcat » : un petit chat assis, dessiné en gros pixels comme dans un jeu vidéo rétro.
// Les émotions passent par les oreilles, les yeux, la bouche, la queue et un petit signe qui flotte (z, ?, !, cœur).
// Le sprite (32 x 32 cases) est redessiné à chaque image puis envoyé au GPU (WebGL2) ; 1 fragment shader l'agrandit
// sans flou, avec un relief par pixel, la lueur des yeux, un halo de la couleur de l'état et des lignes de balayage.
// Vivant : humeur au repos, regard (la tête et les pupilles suivent la souris), oreille (les oreilles se dressent quand
// la voix entendue monte), voix (la bouche s'ouvre avec le niveau), ressort, hochement, sursaut, clic, clignement.

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

// Le chat est un sprite de 32 x 32 pixels, redessiné à chaque image (c'est très peu de cases) puis envoyé au GPU.
// Le shader l'agrandit sans flou, ajoute un léger relief par pixel, la lueur des pixels qui brillent
// (yeux, signes), un halo de la couleur de l'état et des lignes de balayage d'écran rétro.
const G = 32;
// Palette : 0 vide, 1 contour, 2 pelage, 3 pelage sombre, 4 clair (museau, poitrail), 5 rose, 6 œil, 7 blanc, 8 pupille, 9 signe (couleur de l'état).
const PAL = ["#000000", "#24162E", "#F5A04A", "#C8662C", "#FFE3B8", "#FF7BA5", "#8DFF6A", "#FFFFFF", "#1B1030", "#00E5FF"];
const GLOW = new Set([6, 9]);           // ces pixels brillent

// Par émotion : oreilles, yeux, bouche, signe, queue (en l'air 0..1, vitesse, amplitude), saut, couleur de l'état.
const P = {
  idle: { ears: "up", eyes: "open", mouth: "w", tail: [1, 1.5, 1.4], c: "#00E5FF" },
  listening: { ears: "perk", eyes: "big", mouth: "w", tail: [1, 1.0, 0.8], c: "#00FFA3" },
  thinking: { ears: "up", eyes: "lookup", mouth: "flat", glyph: "dots", tail: [1, 0.8, 1.0], c: "#A87BFF" },
  speaking: { ears: "up", eyes: "open", mouth: "open", tail: [1, 1.8, 1.4], c: "#00E5FF" },
  sleep: { ears: "down", eyes: "closed", mouth: "flat", glyph: "z", tail: [0, 0.3, 0.3], c: "#4058FF", dim: 0.7 },
  happy: { ears: "up", eyes: "happy", mouth: "smile", tail: [1, 4.0, 1.8], hop: 1, c: "#FFD000" },
  sad: { ears: "down", eyes: "sad", mouth: "frown", tail: [0, 0.6, 0.5], c: "#4D8BFF", dim: 0.85 },
  angry: { ears: "back", eyes: "narrow", mouth: "hiss", tail: [1, 6.0, 0.8], puff: 1, c: "#FF2E4D" },
  surprised: { ears: "perk", eyes: "big", mouth: "o", glyph: "bang", tail: [1, 0.5, 0.4], puff: 1, c: "#FF9E00" },
  love: { ears: "up", eyes: "heart", mouth: "w", glyph: "heart", tail: [1, 2.5, 1.6], c: "#FF2BD6" },
  confused: { ears: "tilt", eyes: "confused", mouth: "flat", glyph: "q", tail: [1, 1.2, 1.2], c: "#A87BFF" },
  wink: { ears: "up", eyes: "wink", mouth: "smile", tail: [1, 2.5, 1.6], c: "#FFD000" },
};
// Pointe de l'oreille gauche (relative au centre de la tête) ; la droite est le miroir, sauf « tilt ».
const EAR = { up: [-7.5, -12], perk: [-7.5, -13.5], down: [-11.5, -8], back: [-12, -7], tilt: [-7.5, -12] };
const GLYPH = {
  z: ["XXXX", "..X.", ".X..", "XXXX"],
  q: ["XXX", "..X", ".XX", "...", ".X."],
  bang: ["X", "X", "X", ".", "X"],
  heart: ["XX.XX", "XXXXX", ".XXX.", "..X.."],
};
const HEART_EYE = ["X.X", "XXX", ".X."];

/** Dessine le chat dans g (une case = un index de palette). */
function paint(g, f) {
  g.fill(0);
  const part = new Uint8Array(G * G);                         // 1 tête, 2 corps (pour le trait entre les deux)
  const set = (x, y, c, pt = 0) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= G || y < 0 || y >= G) return;
    g[y * G + x] = c;
    if (pt) part[y * G + x] = pt;
  };
  const ell = (cx, cy, rx, ry, c, pt, maxY = G) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry) && y < maxY; y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) set(x, y, c, pt);
  };
  const tri = (a, b, c, col, pt) => {
    const [x0, x1] = [Math.min(a[0], b[0], c[0]), Math.max(a[0], b[0], c[0])];
    const [y0, y1] = [Math.min(a[1], b[1], c[1]), Math.max(a[1], b[1], c[1])];
    const e = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    const s = Math.sign(e(a, b, c[0], c[1]));
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const px = x + 0.5, py = y + 0.5;
        if (e(a, b, px, py) * s >= 0 && e(b, c, px, py) * s >= 0 && e(c, a, px, py) * s >= 0) set(x, y, col, pt);
      }
  };
  const glyph = (rows, x, y, c) => rows.forEach((r, j) => [...r].forEach((ch, i) => ch === "X" && set(x + i, y + j, c)));
  const { hx, hy, by } = f;
  const mx = (x) => 2 * hx - x;               // miroir (coordonnées continues)
  const mc = (x) => 2 * hx - 1 - x;           // miroir (cases)

  // Queue (derrière le corps) : en l'air elle ondule, au sol elle traîne.
  for (let i = 0; i <= 10; i++) {
    const k = i / 10;
    const sw = Math.sin(f.t * f.tail[1] - i * 0.5) * f.tail[2] * k;
    const ux = hx + 7 + i * 0.55 + sw, uy = by + 3 - i * 1.15;
    const gx = hx + 6 + i * 0.9 + sw * 0.3, gy = by + 4.6 - k * k * 1.5;
    ell(ux * f.tail[0] + gx * (1 - f.tail[0]), uy * f.tail[0] + gy * (1 - f.tail[0]), 1.25 + f.puff * 0.4, 1.25 + f.puff * 0.4, i > 8 ? 3 : 2, 2);
  }
  // Corps, poitrail, pattes.
  ell(hx, by, 7.2 + f.puff * 0.5, 5.8, 2, 2, G - 1);
  ell(hx, by - 1, 3.2, 3, 4, 2);
  ell(hx - 3.2, by + 4.6, 2.1, 1.3, 4, 2);
  ell(mx(hx - 3.2), by + 4.6, 2.1, 1.3, 4, 2);
  // Tête et oreilles.
  const rx = 9.6 + f.puff * 0.6, ry = 7.6 + f.puff * 0.3;
  const earL = EAR[f.ears], earR = f.ears === "tilt" ? EAR.down : earL;
  const tipL = [hx + earL[0], hy + earL[1] - f.perk], tipR = [mx(hx + earR[0]), hy + earR[1] - f.perk];
  const baseL = [[hx - 9, hy - 2], [hx - 2.5, hy - 6.5]], baseR = [[mx(hx - 9), hy - 2], [mx(hx - 2.5), hy - 6.5]];
  tri(baseL[0], baseL[1], tipL, 2, 1);
  tri(baseR[0], baseR[1], tipR, 2, 1);
  const shrink = (p, c) => [c[0] + (p[0] - c[0]) * 0.5, c[1] + (p[1] - c[1]) * 0.5];
  for (const [b0, b1, tp] of [[baseL[0], baseL[1], tipL], [baseR[0], baseR[1], tipR]]) {
    const cc = [(b0[0] + b1[0] + tp[0]) / 3, (b0[1] + b1[1] + tp[1]) / 3];
    tri(shrink(b0, cc), shrink(b1, cc), shrink(tp, cc), 5, 1);
  }
  ell(hx, hy, rx, ry, 2, 1);
  // Ombre du pelage en bas de la tête, rayures sur le front, museau, nez.
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    if (part[y * G + x] === 1 && g[y * G + x] === 2 && ((x + 0.5 - hx) / rx) ** 2 + ((y + 0.5 - hy) / ry) ** 2 > 0.72 && y > hy + 2) g[y * G + x] = 3;
  }
  for (const dx of [-2, 0, 1, 3]) { const x = hx + dx - 1; set(x, hy - 7, 3); set(x, hy - 6, 3); }
  set(hx - 1, hy - 5, 3); set(hx, hy - 5, 3);
  ell(hx, hy + 4.4, 4.3, 2.4, 4, 1);
  set(hx - 1, hy + 2, 5); set(hx, hy + 2, 5);

  // Contour : chaque case vide qui touche le chat. Puis le trait entre la tête et le corps.
  const filled = Uint8Array.from(g);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    if (filled[y * G + x]) continue;
    const n = (dx, dy) => { const X = x + dx, Y = y + dy; return X >= 0 && X < G && Y >= 0 && Y < G && filled[Y * G + X]; };
    if (n(1, 0) || n(-1, 0) || n(0, 1) || n(0, -1)) g[y * G + x] = 1;
  }
  for (let y = 1; y < G; y++) for (let x = 0; x < G; x++)
    if (part[y * G + x] === 2 && part[(y - 1) * G + x] === 1) g[y * G + x] = 1;

  // Moustaches (dehors, en clair).
  for (const s of [1, -1]) {
    const X = (x) => (s > 0 ? x : mc(x));
    set(X(hx - 11), hy + 2, 4); set(X(hx - 12), hy + 1, 4);
    set(X(hx - 11), hy + 4, 4); set(X(hx - 12), hy + 5, 4);
  }

  // Yeux. Boîte de 3 x 3 : gauche en (hx-6, hy-2), droite en miroir.
  const eye = (x0, y0, kind, right) => {
    const px = Math.max(0, Math.min(2, 1 + f.gx)), py = f.gy < -0.4 ? 0 : 1;
    const X = (i) => (right ? mc(x0 + i) : x0 + i);
    switch (kind) {
      case "big":
        for (let j = -1; j < 3; j++) for (let i = -1; i < 3; i++) set(X(i), y0 + j, 6);
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) set(X(i + Math.max(-1, Math.min(0, f.gx))), y0 + j + (py ? 0 : -1), 8);
        set(X(-1), y0 - 1, 7);
        break;
      case "closed": for (let i = 0; i < 3; i++) set(X(i), y0 + 2, 1); break;
      case "happy": set(X(0), y0 + 1, 1); set(X(1), y0, 1); set(X(2), y0 + 1, 1); break;
      case "heart": glyph(HEART_EYE.map((r) => (right ? [...r].reverse().join("") : r)), right ? mc(x0 + 2) : x0, y0, 9); break;
      case "narrow":
        for (let i = 0; i < 3; i++) set(X(i), y0 + 1, 6);
        set(X(px), y0 + 1, 8);
        set(X(0), y0 - 1, 1); set(X(1), y0 - 1, 1); set(X(2), y0, 1);
        break;
      case "sad":
        for (let j = 1; j < 3; j++) for (let i = 0; i < 3; i++) set(X(i), y0 + j, 6);
        set(X(px), y0 + 2, 8); set(X(0), y0 + 1, 7);
        set(X(0), y0, 1); set(X(1), y0 - 1, 1); set(X(2), y0 - 1, 1);
        break;
      default: {   // open, lookup
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) set(X(i), y0 + j, 6);
        const up = kind === "lookup";
        const cx = up ? 2 : px;
        set(X(cx), y0 + (up ? 0 : py), 8); set(X(cx), y0 + (up ? 1 : py + 1), 8);
        set(X(up ? 0 : 0), y0, cx === 0 ? 6 : 7);
      }
    }
  };
  let [eL, eR] = { confused: ["open", "big"], wink: ["open", "happy"] }[f.eyes] ?? [f.eyes, f.eyes];
  if (f.blink && ["open", "big", "lookup", "sad", "narrow"].includes(eL)) eL = "closed";
  if (f.blink && ["open", "big", "lookup", "sad", "narrow"].includes(eR)) eR = "closed";
  eye(hx - 6, hy - 2, eL, false);
  eye(hx - 6, hy - 2, eR, true);

  // Bouche (sous le nez).
  const m = hy + 3, L1 = hx - 1, R1 = hx;
  switch (f.mouth) {
    case "smile": set(L1 - 2, m, 1); set(L1 - 1, m + 1, 1); set(L1, m + 1, 5); set(R1, m + 1, 5); set(R1 + 1, m + 1, 1); set(R1 + 2, m, 1); break;
    case "frown": set(L1 - 1, m + 2, 1); set(L1, m + 1, 1); set(R1, m + 1, 1); set(R1 + 1, m + 2, 1); break;
    case "o": set(L1, m + 1, 1); set(R1, m + 1, 1); set(L1, m + 2, 5); set(R1, m + 2, 5); break;
    case "flat": set(L1, m + 1, 1); set(R1, m + 1, 1); break;
    case "hiss": for (let i = -2; i <= 3; i++) set(hx - 1 + i - 0, m + 1, 1); set(L1 - 1, m + 2, 7); set(R1 + 1, m + 2, 7); break;
    case "open": {
      const n = Math.round(f.level * 2.4);
      set(L1 - 1, m, 1); set(R1 + 1, m, 1);
      for (let j = 0; j <= n; j++) { set(L1, m + 1 + j, j === n && n > 0 ? 5 : 1); set(R1, m + 1 + j, j === n && n > 0 ? 5 : 1); }
      break;
    }
    default: set(L1 - 1, m, 1); set(L1, m + 1, 1); set(R1, m + 1, 1); set(R1 + 1, m, 1);   // « w »
  }

  // Signe flottant en haut à droite, couleur de l'état.
  const step = Math.floor(f.t * 2);
  if (f.glyph === "z") { if (step % 2 === 0) glyph(GLYPH.z, 25, 6, 9); else glyph(GLYPH.z, 27, 1, 9); }
  else if (f.glyph === "dots") for (let i = 0; i < 3; i++) set(25 + i * 2, 3 - (step % 3 === i ? 1 : 0), 9);
  else if (f.glyph === "q") glyph(GLYPH.q, 27, 1 + (step % 2), 9);
  else if (f.glyph === "bang") glyph(GLYPH.bang, 28, 1, 9);
  else if (f.glyph === "heart") glyph(GLYPH.heart, 25, 5 - (step % 4), 9);
}

const FS = `#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform sampler2D uTex;
uniform float uT, uZoom, uPx, uHalo, uDim;
uniform vec3 uAcc;
const float GRID = ${G}.0;
vec4 cell(ivec2 c) { if (c.x < 0 || c.y < 0 || c.x >= ${G} || c.y >= ${G}) return vec4(0.0); return texelFetch(uTex, c, 0); }
void main() {
  vec2 p = vec2(vP.x, -vP.y) * uZoom;
  vec2 g = (p + 0.95) / 1.9 * GRID;           // coordonnées en cases
  ivec2 c = ivec2(floor(g));
  vec2 f = fract(g);
  vec3 col = vec3(0.0);
  float a = 0.0;
  // Halo de l'état derrière le chat, et ombre au sol.
  float r = length(p - vec2(0.0, 0.05));
  col += uAcc * exp(-r * r * 3.5) * 0.22 * uHalo;
  vec2 sh = (p - vec2(0.0, 0.93)) / vec2(0.55, 0.05);
  col += uAcc * exp(-dot(sh, sh)) * 0.25 * uHalo;
  // Lueur des pixels qui brillent (yeux, signes).
  float glow = 0.0; vec3 gc = vec3(0.0);
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    vec4 t = cell(c + ivec2(i, j));
    if (t.a > 0.9) { float d = length(vec2(float(i), float(j)) + 0.5 - f); float w = exp(-d * d * 0.35); glow += w; gc += t.rgb * w; }
  }
  col += gc * 0.09;
  vec4 t = cell(c);
  if (t.a > 0.0) {
    // Un pixel : un carré net, un peu plus clair en haut à gauche, un peu plus sombre en bas à droite.
    float e = 0.12;
    float hl = (f.x < e || f.y < e) ? 1.1 : (f.x > 1.0 - e || f.y > 1.0 - e) ? 0.85 : 1.0;
    vec3 pc = t.rgb * hl * (t.a > 0.9 ? 1.15 : uDim);
    col = pc + col * (t.a > 0.9 ? 0.5 : 0.0);
    a = 1.0;
  }
  // Lignes de balayage d'écran rétro.
  col *= 0.9 + 0.1 * smoothstep(0.0, 0.25, abs(fract(g.y) - 0.5));
  a = clamp(max(a, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  o = vec4(min(col, vec3(a)), a);
}`;

const STATE_HALO = { idle: 0.6, listening: 1.1, thinking: 0.9, speaking: 1.0, sleep: 0.3 };

export function create(container, { reducedMotion = false } = {}) {
  const sf = surface(container, FS);
  const gl = sf.gl;
  const L = makeLife(reducedMotion);
  const g = new Uint8Array(G * G);
  const rgba = new Uint8Array(G * G * 4);
  const pal = PAL.map(rgb);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, G, G, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  let acc = rgb(P.idle.c), halo = STATE_HALO.idle, dim = 1, tt = 0, raf = 0, dead = false;

  function frame(now) {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    L.tick(now);
    const dt = L.dt;
    tt += dt * (reducedMotion ? 0.3 : 1) * (L.key === "idle" ? 0.6 + 0.8 * L.mood.energy : 1);
    const p = P[L.key];
    const k = Math.min(1, dt * 5);
    const ta = L.key === "idle" ? moodTint(rgb(p.c), L.mood) : rgb(p.c);
    acc = acc.map((v, i) => v + (ta[i] - v) * k);
    const hk = (STATE_HALO[L.state] ?? 0.6) * (L.state === "listening" ? 1 + L.hearingS * 0.6 : 1) * (L.state === "speaking" ? 0.8 + L.levelS * 0.5 : 1);
    halo += (hk - halo) * Math.min(1, dt * 4);
    dim += ((p.dim ?? 1) - dim) * k;
    // Mouvements en cases entières, comme dans un vieux jeu : respiration, saut de joie, ressort, hochement.
    const hop = p.hop && !reducedMotion && Math.sin(tt * 9) > 0.3 ? -1 : 0;
    const spring = L.pop < -0.06 ? 1 : L.pop > 0.06 ? -1 : 0;
    const bob = (L.breathe > 0.55 ? -1 : 0) + (L.nod > 0.3 ? 1 : 0) + spring + hop;
    const gx = Math.round(Math.max(-1, Math.min(1, L.look.x * 1.6)));
    const f = {
      t: tt, hx: 16 + gx, hy: 13 + bob, by: 24 + hop + Math.max(0, spring),
      ears: p.ears, eyes: p.eyes, mouth: L.state === "speaking" && p.mouth !== "o" ? "open" : p.mouth, glyph: p.glyph,
      tail: p.tail, puff: p.puff ?? 0, perk: L.state === "listening" && L.hearingS > 0.3 ? 1 : 0,
      gx: Math.round(L.look.x * 1.4), gy: L.look.y, blink: L.blink > 0.4, level: L.levelS,
    };
    paint(g, f);
    pal[9] = acc;
    for (let i = 0; i < G * G; i++) {
      const c = g[i], q = pal[c];
      rgba[i * 4] = q[0] * 255; rgba[i * 4 + 1] = q[1] * 255; rgba[i * 4 + 2] = q[2] * 255;
      rgba[i * 4 + 3] = c === 0 ? 0 : GLOW.has(c) ? 255 : 200;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, G, G, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    sf.draw(1.0, (u, px) => {
      gl.uniform1i(u.uTex, 0);
      gl.uniform1f(u.uT, tt);
      gl.uniform1f(u.uPx, px);
      gl.uniform1f(u.uHalo, halo);
      gl.uniform1f(u.uDim, dim);
      gl.uniform3f(u.uAcc, acc[0], acc[1], acc[2]);
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
