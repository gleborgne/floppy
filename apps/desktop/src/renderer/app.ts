// Page de l'avatar : le corps par défaut. Parle au noyau par un MessagePort (protocole v0, voir packages/protocol).
//   { j: <message JSON> }  ou  { a: <audio> }  (micro : Float32Array 16 kHz ; voix : 4 octets taux + PCM int16)
// Un module par métier (assemblés par app-wire.ts) : app-texts (fr/en), app-face (avatar), app-life (clics, manies, regard),
// app-bubble (bulle et cartes), app-playback (voix), app-mic (micro), app-protocol (noyau et messages de la fenêtre).
import { createApp } from "./app-wire.ts";

const app = createApp({ host: window.floppyHost });
window.addEventListener("message", app.protocol.windowMessage);
