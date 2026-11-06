// Rendu WebGL2 de l'avatar : tout est dessiné dans un shader de fragments, avec des formes SDF (distances signées).
// Couches, du fond vers l'avant :
//   1. aurore colorée animée (teinte de l'émotion), qui s'efface vers les bords de la fenêtre ;
//   2. halo animé autour de la tête (couleurs qui tournent, pulse avec la voix) ;
//   3. tête : écran noir 4:3 aux bords arrondis, légèrement bombé (tube cathodique) : yeux et bouche lumineux.
// Les paramètres viennent de Face (face.js), interpolés à chaque image.

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;        // taille du canvas en pixels
uniform float uScale;     // pixels par unité
uniform vec2 uOffset;     // décalage de la tête (unités) : rebond, tremblement
uniform float uTilt;      // inclinaison de la tête (radians)
uniform float uTime;
uniform vec3 uColor;      // couleur des yeux
uniform float uLevel;     // niveau de la voix 0..1
uniform float uHalo;      // intensité du halo
uniform float uBg;        // 1 = aurore de fond

uniform vec4 uEye[2];     // centre x, centre y, demi-largeur, demi-hauteur
uniform float uEyeR[2];
uniform vec3 uLidTop[2];  // normale (x, y), décalage : retire dot(n, p) < décalage
uniform float uLidTopOn[2];
uniform vec3 uLidBot[2];  // disque retiré : centre, rayon
uniform float uLidBotOn[2];
uniform float uBot[2];     // force de la paupière du bas (0..1) : au-delà de ~0.3, l'œil devient un arc
uniform float uHeart;

uniform vec4 uMouthA;     // extrémités A et C
uniform vec2 uMouthB;     // contrôle de la courbe du haut
uniform float uMouthBotY; // contrôle de la courbe du bas
uniform float uMouthOn;
uniform float uMouthOpen;

uniform float uBlush;
uniform vec4 uFx;         // larmes, sueur, zzz, étoiles
uniform vec4 uFx2;        // ?, !, colère, …

const vec2 HEAD = vec2(144.0, 108.0);   // demi-taille de la tête : 4:3
const float HEAD_R = 40.0;              // rayon des coins
const float PI = 3.14159265;

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdHeart(vec2 p) { // iq ; p.y vers le haut
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  vec2 m = 0.5 * vec2(max(p.x + p.y, 0.0));
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)), dot(p - m, p - m))) * sign(p.x - p.y);
}
float sdArc(vec2 p, float r, float a0, float a1, float w) {
  float a = atan(p.y, p.x);
  float m = 0.5 * (a0 + a1), h = 0.5 * (a1 - a0);
  float da = abs(mod(a - m + PI, 2.0 * PI) - PI);
  if (da < h) return abs(length(p) - r) - w;
  return min(length(p - r * vec2(cos(a0), sin(a0))), length(p - r * vec2(cos(a1), sin(a1)))) - w;
}
float sdStar4(vec2 p, float r) { p = abs(p); return min(p.x * 0.28 + p.y, p.y * 0.28 + p.x) - r * 0.28; }
float sdDrop(vec2 p, float r) {  // goutte, pointe vers le haut (y vers le bas)
  float c = length(p) - r;
  float k = clamp(-p.y / (r * 2.2), 0.0, 1.0);
  float d2 = max(abs(p.x) - r * (1.0 - k), -p.y - r * 2.2);
  return min(c, max(d2, p.y));
}
float quadY(float x, vec2 A, float By, vec2 C) {
  float t = clamp((x - A.x) / max(C.x - A.x, 1e-3), 0.0, 1.0);
  return (1.0 - t) * (1.0 - t) * A.y + 2.0 * t * (1.0 - t) * By + t * t * C.y;
}
vec3 hue(float h) { return 0.5 + 0.5 * cos(6.2831853 * (h + vec3(0.0, 0.33, 0.67))); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

// Traits lumineux de l'écran (unités, y vers le bas).
float features(vec2 p, out float blushD) {
  float d = 1e5;
  for (int i = 0; i < 2; i++) {
    vec4 e = uEye[i];
    vec2 q = p - e.xy;
    if (uHeart > 0.5) {
      float s = e.z * 1.25;
      d = min(d, sdHeart(vec2(q.x, -q.y) / s + vec2(0.0, 0.45)) * s);
      continue;
    }
    float de = sdRoundBox(q, e.zw, uEyeR[i]);
    if (uLidTopOn[i] > 0.5) de = max(de, uLidTop[i].z - dot(uLidTop[i].xy, p));
    if (uLidBotOn[i] > 0.5) de = max(de, uLidBot[i].z - length(p - uLidBot[i].xy));
    // Yeux qui sourient : un arc épais (distance exacte, halo propre) remplace la découpe.
    float arcK = smoothstep(0.18, 0.4, uBot[i]);
    if (arcK > 0.0) {
      float rad = e.z * 0.92;
      float th = max(3.2, e.w * (0.95 - uBot[i]) * 0.42);
      vec2 ac = e.xy + vec2(0.0, e.w * 0.55 + rad * 0.25);
      float da = sdArc(p - ac, rad, -PI + 0.28, -0.28, th);
      de = mix(de, da, arcK);
    }
    d = min(d, de);
  }
  if (uMouthOn > 0.5) {
    vec2 A = uMouthA.xy, C = uMouthA.zw;
    float halfW = 0.5 * (C.x - A.x), cx = 0.5 * (A.x + C.x);
    float yt = quadY(p.x, A, uMouthB.y, C);
    float dm;
    if (uMouthOpen > 0.02) {
      float yb = quadY(p.x, A, uMouthBotY, C);
      dm = max(max(yt - p.y, p.y - yb), abs(p.x - cx) - halfW) - 1.5;
    } else {
      dm = (abs(p.x - cx) <= halfW ? abs(p.y - yt) * 0.92 : min(length(p - A), length(p - C))) - 3.8;
    }
    d = min(d, dm);
  }
  float t = uTime;
  if (uFx.x > 0.0) for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    float ph = fract(t * 0.9 + float(s) * 0.5);
    vec2 c = vec2(uEye[s].x + side * 10.0, uEye[s].y + uEye[s].w + 8.0 + ph * 30.0);
    d = min(d, sdDrop(p - c, 5.0) + ph * 4.0);
  }
  if (uFx.y > 0.0) d = min(d, sdDrop(p - vec2(uEye[1].x + 38.0, uEye[1].y - 26.0 + sin(t * 2.0) * 2.0), 6.0));
  if (uFx.z > 0.0) for (int z = 0; z < 3; z++) {
    float ph = fract(t * 0.45 + float(z) / 3.0);
    float sz = 5.0 + ph * 4.0;
    vec2 q = p - vec2(70.0 + ph * 22.0, -36.0 - ph * 36.0);
    float dz = min(min(sdSegment(q, vec2(-sz, -sz), vec2(sz, -sz)), sdSegment(q, vec2(sz, -sz), vec2(-sz, sz))), sdSegment(q, vec2(-sz, sz), vec2(sz, sz))) - 1.8;
    d = min(d, dz + (1.0 - sin(ph * PI)) * 6.0);
  }
  if (uFx.w > 0.0) {
    d = min(d, sdStar4(p - vec2(-100.0, -56.0), 6.0 + sin(t * 5.0) * 2.5));
    d = min(d, sdStar4(p - vec2(98.0, -62.0), 7.0 + sin(t * 5.0 + 1.7) * 2.5));
    d = min(d, sdStar4(p - vec2(92.0, 34.0), 4.5 + sin(t * 5.0 + 3.1) * 2.0));
  }
  if (uFx2.x > 0.0) {
    vec2 q = p - vec2(94.0, -50.0 + sin(t * 3.0) * 3.0);
    float dq = sdArc(q - vec2(0.0, -6.0), 8.0, -3.4, 1.2, 2.2);
    dq = min(dq, sdSegment(q, vec2(1.5, 2.0), vec2(0.0, 7.0)) - 2.2);
    d = min(d, min(dq, length(q - vec2(0.0, 15.0)) - 2.6));
  }
  if (uFx2.y > 0.0) {
    vec2 q = p - vec2(98.0, -52.0);
    d = min(d, min(sdSegment(q, vec2(0.0, -14.0), vec2(0.0, 4.0)) - 2.8, length(q - vec2(0.0, 13.0)) - 3.0));
  }
  if (uFx2.z > 0.0) {
    vec2 q = p - vec2(94.0, -56.0);
    float r = 7.0 + sin(t * 8.0);
    for (int k = 0; k < 4; k++) {
      float a = float(k) * 1.5708 + 0.785;
      d = min(d, sdArc(q - vec2(cos(a), sin(a)) * r, r * 0.75, a + 2.2, a + 4.1, 1.6));
    }
  }
  if (uFx2.w > 0.0) for (int k = 0; k < 3; k++) {
    float on = 0.35 + 0.65 * max(0.0, sin(t * 4.0 - float(k) * 0.7));
    d = min(d, length(p - vec2(76.0 + float(k) * 13.0, -70.0)) - 3.0 * on - 0.6);
  }
  blushD = 1e5;
  if (uBlush > 0.01) for (int s = 0; s < 2; s++) {
    vec2 c = vec2(uEye[s].x + (s == 0 ? -10.0 : 10.0), uEye[s].y + uEye[s].w + 12.0);
    blushD = min(blushD, (length((p - c) / vec2(15.0, 6.5)) - 1.0) * 6.5);
  }
  return d;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);       // y vers le bas
  vec2 w = (frag - uRes * 0.5) / uScale;                           // unités, centre de la fenêtre
  vec2 hp = w - uOffset;                                           // centre de la tête
  float c = cos(uTilt), s = sin(uTilt);
  hp = mat2(c, s, -s, c) * hp;
  float px = 1.0 / uScale;
  float t = uTime;

  // ---------- 1. aurore de fond
  vec2 wn = w / (uRes / uScale * 0.5);                             // -1..1 sur la fenêtre
  float r = length(wn * vec2(1.0, 1.08));
  float bgMask = uBg * smoothstep(1.02, 0.55, r);
  vec2 q1 = wn + 0.25 * vec2(sin(t * 0.31 + wn.y * 2.0), cos(t * 0.27 + wn.x * 2.0));
  float n1 = 0.5 + 0.5 * sin(q1.x * 2.3 + t * 0.4) * cos(q1.y * 2.1 - t * 0.33);
  float n2 = 0.5 + 0.5 * sin(length(q1 - vec2(0.4, -0.3)) * 3.4 - t * 0.5);
  vec3 cA = uColor;
  vec3 cB = mix(vec3(0.55, 0.30, 0.95), uColor.bgr, 0.25);         // violet
  vec3 cC = vec3(1.0, 0.45, 0.65);                                  // rose
  vec3 aurora = mix(mix(cA, cB, n1), cC, n2 * 0.45) * 0.55;
  vec3 col = aurora;
  float alpha = bgMask * 0.92;

  // ---------- 2. halo autour de la tête
  float dHead = sdRoundBox(hp, HEAD, HEAD_R);
  float dOut = max(dHead, 0.0);
  float ang = atan(hp.y, hp.x) / (2.0 * PI);
  vec3 haloCol = mix(hue(ang + t * 0.08), uColor, 0.35);
  float pulse = 0.75 + 0.25 * sin(t * 2.2) + uLevel * 0.9;
  float halo = (exp(-dOut / 7.0) * 0.9 + exp(-dOut / 22.0) * 0.45) * uHalo * pulse;
  halo *= 0.8 + 0.2 * sin(ang * 6.2831853 * 3.0 - t * 2.0);       // ondulation qui tourne
  col += haloCol * halo;
  alpha = max(alpha, clamp(halo, 0.0, 1.0));

  // ---------- 3. la tête : un écran noir 4:3 aux bords arrondis, légèrement bombé
  float headMask = smoothstep(px * 1.2, -px * 1.2, dHead);
  vec2 sn = hp / HEAD;
  vec2 fp = hp * (1.0 + 0.05 * dot(sn, sn));                        // courbure de tube cathodique
  float blushD;
  float d = features(fp, blushD);
  float aa = 1.2 * px;
  float core = smoothstep(aa, -aa, d);
  float dd = max(d, 0.0);
  float glow = exp(-dd / 5.0) * 0.55 + exp(-dd / 16.0) * 0.22;
  float scan = 0.92 + 0.08 * sin(frag.y * PI / max(1.5, uScale * 2.2));
  vec3 light = uColor * (core * 1.05 + glow * (0.94 + 0.06 * sin(t * 1.6))) * scan;
  light += vec3(1.0) * core * smoothstep(-2.0, -9.0, d) * 0.32;     // cœur plus blanc : volume
  if (uBlush > 0.01) light += vec3(1.0, 0.35, 0.6) * smoothstep(4.0, -4.0, blushD) * 0.55 * uBlush;
  vec3 glass = mix(vec3(0.024, 0.028, 0.036), vec3(0.004, 0.005, 0.008), smoothstep(0.0, 1.25, length(sn)));
  glass += (hash(frag + floor(t * 24.0)) - 0.5) * 0.010;
  float sheen = smoothstep(0.2, 0.0, abs(sn.y + 0.66 + sn.x * 0.3)) * smoothstep(0.1, -0.5, sn.y);
  glass += vec3(0.05, 0.06, 0.075) * sheen;
  glass += haloCol * exp(-abs(dHead) / 3.0) * 0.18 * uHalo;          // le halo effleure le bord
  col = mix(col, glass + light, headMask);
  alpha = max(alpha, headMask);

  outColor = vec4(col, clamp(alpha, 0.0, 1.0));
}`;

export function createGLRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false, alpha: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const cache = {};
  const U = (name) => (cache[name] ??= gl.getUniformLocation(prog, name));

  return {
    kind: "webgl2",
    draw(u, w, h, dpr) {
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U("uRes"), W, H);
      gl.uniform1f(U("uScale"), u.scale * dpr);
      gl.uniform2f(U("uOffset"), u.ox, u.oy);
      gl.uniform1f(U("uTilt"), u.tilt);
      gl.uniform1f(U("uTime"), u.time);
      gl.uniform3f(U("uColor"), ...u.color);
      gl.uniform1f(U("uLevel"), u.level);
      gl.uniform1f(U("uHalo"), u.halo);
      gl.uniform1f(U("uBg"), u.background ? 1 : 0);
      gl.uniform4fv(U("uEye[0]"), u.eyes.flatMap((e) => [e.x, e.y, e.hw, e.hh]));
      gl.uniform1fv(U("uEyeR[0]"), u.eyes.map((e) => e.r));
      gl.uniform3fv(U("uLidTop[0]"), u.eyes.flatMap((e) => e.lidTop));
      gl.uniform1fv(U("uLidTopOn[0]"), u.eyes.map((e) => (e.lidTopOn ? 1 : 0)));
      gl.uniform3fv(U("uLidBot[0]"), u.eyes.flatMap((e) => e.lidBot));
      gl.uniform1fv(U("uLidBotOn[0]"), u.eyes.map((e) => (e.lidBotOn ? 1 : 0)));
      gl.uniform1fv(U("uBot[0]"), u.eyes.map((e) => e.bot));
      gl.uniform1f(U("uHeart"), u.heart);
      gl.uniform4f(U("uMouthA"), u.mouth.ax, u.mouth.ay, u.mouth.cx, u.mouth.cy);
      gl.uniform2f(U("uMouthB"), u.mouth.bx, u.mouth.by);
      gl.uniform1f(U("uMouthBotY"), u.mouth.botY);
      gl.uniform1f(U("uMouthOn"), u.mouth.on ? 1 : 0);
      gl.uniform1f(U("uMouthOpen"), u.mouth.open);
      gl.uniform1f(U("uBlush"), u.blush);
      gl.uniform4f(U("uFx"), u.fx.tears, u.fx.sweat, u.fx.zzz, u.fx.sparkle);
      gl.uniform4f(U("uFx2"), u.fx.question, u.fx.exclaim, u.fx.anger, u.fx.dots);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
