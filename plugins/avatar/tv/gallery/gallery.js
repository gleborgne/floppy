// Galerie des émotions (ou des états avec #states), pour la doc et les réglages.
// Un seul contexte WebGL (le navigateur en limite le nombre) : chaque visage est rendu puis copié dans sa case.
import { Face, EMOTION_PRESETS } from "../renderer/face.js";
import { createGLRenderer } from "../renderer/face-gl.js";

const grid = document.getElementById("grid");
const states = location.hash === "#states" ? ["idle", "listening", "thinking", "speaking", "sleep"] : null;
const items = states ?? Object.keys(EMOTION_PRESETS);
const W = 168, H = 132, dpr = window.devicePixelRatio || 1;
const gl = document.createElement("canvas");
const renderer = createGLRenderer(gl);

const cells = items.map((name) => {
  const cell = document.createElement("div");
  cell.className = "cell";
  cell.innerHTML = `<canvas width="${W * dpr}" height="${H * dpr}" style="width:${W}px;height:${H}px"></canvas><div>${name}</div>`;
  grid.appendChild(cell);
  const face = new Face(null, { background: true });
  if (states) { face.setState(name); face.setLevel(0.5); } else face.setEmotion(name);
  face.nextBlink = Infinity;
  face.saccade = { x: 0, y: 0, until: Infinity };
  face.snap();
  return { face, ctx: cell.querySelector("canvas").getContext("2d") };
});

function frame(now) {
  for (const { face, ctx } of cells) {
    const u = face.step(now);
    u.scale = Math.min(W / 420, H / 330);
    renderer.draw(u, W, H, dpr);
    ctx.clearRect(0, 0, W * dpr, H * dpr);
    ctx.drawImage(gl, 0, 0);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
