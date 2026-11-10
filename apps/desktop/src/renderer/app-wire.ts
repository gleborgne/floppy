// Assemblage de la page de l'avatar : crée chaque module et lui donne ce qu'il lit (déclaré par son interface *Deps).
// Seul le protocole écrit la session et le lien ; l'ordre de création garde celui des minuteries (vie, puis voix).
import { AvatarMotion } from "./avatar-motion.ts";
import { createBubble } from "./app-bubble.ts";
import { createFace } from "./app-face.ts";
import { createLife } from "./app-life.ts";
import { createMic } from "./app-mic.ts";
import { createPlayback } from "./app-playback.ts";
import { createProtocol } from "./app-protocol.ts";
import { createLink, createSession } from "./app-session.ts";
import { createTexts } from "./app-texts.ts";

export interface AppEnv {
  /** Pont de l'app (window.floppyHost) : absent hors de l'app. */
  host?: FloppyHostApi;
  /** Charge le module d'un avatar (par défaut `import()`) ; seul un test le remplace. */
  importModule?: (src: string) => Promise<AvatarModule>;
}

export function createApp(env: AppEnv = {}) {
  const { host } = env;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const motion = new AvatarMotion(reducedMotion);
  const session = createSession();
  const link = createLink();
  const texts = createTexts();
  const avatar = createFace({ reducedMotion, motion, session, importModule: env.importModule });
  const life = createLife({ face: avatar.face, session, mood: avatar.mood, host });
  const bubble = createBubble({ texts, session });
  const playback = createPlayback({ face: avatar.face, life, link });
  const mic = createMic({ face: avatar.face, session, link, bubble, host });
  const protocol = createProtocol({ host, texts, face: avatar.face, loadAvatar: avatar.loadAvatar, life, bubble, playback, mic, session, link });
  return { texts, face: avatar.face, loadAvatar: avatar.loadAvatar, life, bubble, playback, protocol, session, link };
}
