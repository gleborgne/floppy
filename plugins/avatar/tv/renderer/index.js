// Avatar « tv » : le visage TV (WebGL). Le rendu est fait par face.js / face-gl.js.
import { Face } from "./face.js";

export function create(container, { reducedMotion = false, motion } = {}) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  container.append(canvas);
  const face = new Face(canvas, { background: true, reducedMotion, motion });
  return {
    setState: (s) => face.setState(s),
    // intensité (1 sans valeur), puis durée en ms (le protocole les envoie avec l'émotion).
    setEmotion: (name, intensity, ms) => face.setEmotion(name, ms, intensity),
    setLevel: (v) => face.setLevel(reducedMotion ? v * 0.5 : v),
    // Facultatif dans l'interface d'avatar (voir apps/desktop/src/renderer/app.js).
    setMood: (valence, energy) => face.setMood(valence, energy),
    lookAt: (x, y) => face.lookAt(x, y),
    setHearing: (v) => face.setHearing(v),
    cue: (name) => face.cue(name),
    setAttention: (target) => face.setAttention(target),
    setSpeechTime: (seconds) => face.setSpeechTime(seconds),
    setSpeechGesture: (intent, intensity, at) => face.setSpeechGesture(intent, intensity, at),
    destroy() { face.destroy(); canvas.remove(); },
  };
}
