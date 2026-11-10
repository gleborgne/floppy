// Avatar de la page (plugin : plugins/avatar/<id>/renderer/index.js) et la façade `face` que les autres modules appellent.
// Un avatar exporte create(container, { reducedMotion, motion }) → { setState, setEmotion(name, intensity, ms), setLevel, destroy }
// et, s'il sait les montrer : setMood(valence, energy), lookAt(x, y) (-1..1), setHearing(niveau 0..1), cue(nom), resize,
// setMouth(open, wide) (0..1 ; wide : 0 bouche arrondie « o », 1 étirée « i » ; en plus de setLevel, jamais à sa place).
// Le noyau envoie toujours les mêmes états et émotions ; `face` les garde et les rejoue sur l'avatar chargé.
import type { SpeechGesture } from "@floppy/protocol";
import type { AvatarMotion } from "./avatar-motion.ts";
import { $, errText } from "./app-dom.ts";
import type { SessionView } from "./app-session.ts";

export interface FaceDeps {
  reducedMotion: boolean;
  /** Horloge de mouvement partagée avec les avatars (créée par l'appelant, qui la partage aussi avec eux). */
  motion: AvatarMotion;
  /** Lecture seule : `approvals` décide de l'attention rejouée sur un avatar qu'on vient de charger. */
  session: Pick<SessionView, "approvals">;
  /** Charge le module d'un avatar (par défaut `import()`) ; seul un test le remplace. */
  importModule?: (src: string) => Promise<AvatarModule>;
}

/** Propriétaire de l'avatar chargé (`current`) et de ce qu'il faut lui rejouer (`last`). */
export function createFace(deps: FaceDeps) {
  const { reducedMotion, motion, session } = deps;
  const importModule = deps.importModule ?? ((src: string): Promise<AvatarModule> => import(src));
  // Aucun avatar en dur : le noyau (plugin body-electron) dit lequel afficher et où est son dessin (message display).
  // Tant qu'il n'en a pas donné, ou si le chargement échoue, la page reste dans un état neutre (aucun avatar).
  let current: AvatarInstance | null = null;           // avatar chargé
  let currentId = "";
  let loadSeq = 0;
  // Au démarrage, Floppy dort (zzz) jusqu'au premier état envoyé par le noyau : la conversation l'envoie seulement
  // quand la voix et le cerveau sont prêts (modèles chargés).
  const last: { state: string; emotion: string | null; intensity: number | undefined; emotionUntil: number; level: number; mood: { valence: number; energy: number } | null } = { state: "sleep", emotion: null, intensity: undefined, emotionUntil: 0, level: 0, mood: null };
  const face = {
    setState(s: string) { last.state = s; motion.setState(s); current?.setState(s); },
    setEmotion(name: string, ms?: number, intensity?: number) {
      last.emotion = name;
      last.intensity = intensity;
      last.emotionUntil = ms ? performance.now() + ms : 0;
      current?.setEmotion(name, intensity, ms);
    },
    setLevel(v: number) { last.level = v; current?.setLevel(v); },
    setMouth(open: number, wide: number) { current?.setMouth?.(open, wide); },
    setMood(valence: number, energy: number) { last.mood = { valence, energy }; current?.setMood?.(valence, energy); },
    lookAt(x: number, y: number) { current?.lookAt?.(x, y); },
    setHearing(v: number) { current?.setHearing?.(v); },
    cue(name: string) { current?.cue?.(name); },
    setAttention(target: string) { motion.setAttention(target); current?.setAttention?.(target); },
    setSpeechTime(seconds: number) { motion.setTime(seconds); current?.setSpeechTime?.(seconds); },
    setSpeechGesture(intent: SpeechGesture | null, intensity?: number, at?: number) { motion.play(intent, intensity, at); current?.setSpeechGesture?.(intent, intensity, at); },
  };
  /** État neutre : aucun avatar affiché. */
  function clearAvatar() {
    loadSeq++;
    try { current?.destroy(); } catch { /* déjà détruit */ }
    current = null;
    currentId = "";
    $("face")?.replaceChildren();
  }
  async function loadAvatar(rawId: unknown, url: unknown): Promise<void> {
    const id = /^[a-z0-9_-]+$/i.test(String(rawId ?? "")) ? String(rawId) : "";
    // Seulement un module local (file://) : le dessin d'un plugin d'avatar installé.
    const src = typeof url === "string" && url.startsWith("file:") ? url : "";
    if (!id || !src) { if (current) clearAvatar(); return; }
    if (id === currentId && current) return;
    const seq = ++loadSeq;
    let mod: AvatarModule;
    try {
      mod = await importModule(src);
    } catch (e) {
      console.log(`avatar ${id} : chargement impossible (${errText(e)})`);
      return;
    }
    if (seq !== loadSeq) return;
    const box = $("face");
    try { current?.destroy(); } catch { /* déjà détruit */ }
    box.replaceChildren();
    try {
      current = mod.create(box, { reducedMotion, motion });
    } catch (e) {
      console.log(`avatar ${id} : création impossible (${errText(e)})`);
      current = null;
      currentId = "";
      return;
    }
    currentId = id;
    // On rejoue l'état courant sur le nouvel avatar.
    current.setState(last.state);
    current.setLevel(last.level);
    current.setAttention?.(session.approvals.size ? "approval" : last.state);
    if (last.mood) current.setMood?.(last.mood.valence, last.mood.energy);
    if (last.emotion) {
      const left = last.emotionUntil ? last.emotionUntil - performance.now() : 0;
      if (!last.emotionUntil || left > 0) current.setEmotion(last.emotion, last.intensity, last.emotionUntil ? left : undefined);
    }
    console.log(`avatar : ${id}`);
  }
  return { face, loadAvatar, /** Dernière humeur envoyée par le noyau (pour choisir une manie). */ mood: () => last.mood };
}
export type Face = ReturnType<typeof createFace>["face"];
