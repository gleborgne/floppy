// Page de l'avatar : le corps par défaut. Parle au noyau par un MessagePort (protocole v0, voir packages/protocol).
//   { j: <message JSON> }  ou  { a: <audio> }  (micro : Float32Array 16 kHz ; voix : 4 octets taux + PCM int16)

// Module : aucun nom global partagé avec les autres pages (placé en tête : la fin du fichier est lue seule par un test).
export {};
import { SpeechExpressions } from "./speech-expressions.ts";
import { AvatarMotion } from "./avatar-motion.ts";
import type { SpeechGesture } from "@floppy/protocol";

/** Demande d'outil du noyau (tool.call). */
interface ToolCallMsg { type: "tool.call"; name: string; callId: string; args?: { titre?: unknown; lignes?: string[]; coin?: string; ecran?: unknown; cible?: string } }
/** Message du noyau reçu par l'avatar (protocole v0) : les types que cette page ne traite pas sont ignorés. */
type KernelMsg =
  | { type: "welcome"; assistant?: { language?: string } }
  | { type: "state"; state: string }
  | { type: "emotion"; emotion: string; intensity?: number; ms?: number; nextAudio?: string }
  | { type: "speech.gesture"; intent: SpeechGesture; intensity: number; nextAudio: string }
  | { type: "mood"; valence: number; energy: number }
  | { type: "cue"; cue: string }
  | { type: "transcript"; text: string }
  | { type: "dictation"; del?: number; ins?: string }
  | { type: "reply.delta"; text: string }
  | { type: "reply.done"; text?: string }
  | { type: "interrupt" }
  | { type: "duck"; on?: boolean }
  | { type: "approval.request"; id: string; summary: string; ttl_s: number }
  | { type: "approval.closed"; id: string }
  | ToolCallMsg
  | { type: "card"; title: string; lines: string[] }
  | { type: "panel"; id?: string; title?: string; a2ui?: unknown[] }
  | { type: "document"; id?: string; titre?: string; markdown?: string; liste?: unknown[] }
  | { type: "documents"; liste: unknown[] }
  | { type: "notify"; text: string; important?: boolean }
  | { type: "error"; text: string };
/** Message envoyé au noyau (hello, playback, tool.result, approval.response, text, ptt…) : `type` et ses champs. */
interface OutMsg { type: string; [key: string]: unknown }
type Lang = "fr" | "en";
/** Texte d'une carte : un texte, ou une clé de TEXTS (suit la langue de l'interface). */
type CardText = string | { key: string };
/** Carte affichée : son élément garde de quoi se retraduire quand la langue change. */
type CardEl = HTMLDivElement & { _relabel?: () => void };
/** Message d'une exception (Error ou autre valeur lancée). */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Éléments de la page : ils existent dans index.html (les `?.` plus bas restent par prudence).
const $ = (id: string) => document.getElementById(id) as HTMLElement;
// ------------------------------------------------------------------ textes (fr / en)
// Ce qu'on lit (bulle, cartes) suit la langue de l'interface (message display) ; ce que Floppy dit (résultats d'outils,
// repris par le cerveau) suit la langue de l'assistant (message welcome du noyau).
type TextKey = "you" | "listen" | "faceTip" | "closeTip" | "micDown" | "ask" | "yes" | "no" | "important" | "info" | "error";
const TEXTS: Record<Lang, Record<TextKey, string>> = {
  fr: {
    you: "Toi", listen: "Je t'écoute…", faceTip: "Floppy — Ctrl+Alt+F pour parler", closeTip: "Cliquer pour fermer",
    micDown: "Micro indisponible", ask: "Ton accord ?", yes: "Oui", no: "Non", important: "Important", info: "Info", error: "Erreur",
  },
  en: {
    you: "You", listen: "I'm listening…", faceTip: "Floppy — Ctrl+Alt+F to talk", closeTip: "Click to close",
    micDown: "Microphone unavailable", ask: "Your approval?", yes: "Yes", no: "No", important: "Important", info: "Info", error: "Error",
  },
};
const SAID: Record<Lang, { cardShown: string; unknownTool: (n: string) => string }> = {
  fr: { cardShown: "Carte affichée.", unknownTool: (n) => `outil inconnu : ${n}` },
  en: { cardShown: "Card displayed.", unknownTool: (n) => `unknown tool: ${n}` },
};
let lang: Lang = "fr";            // langue de l'interface
let assistantLang = "";     // langue de l'assistant (welcome) ; vide : celle de l'interface
// Sur Mac, Ctrl+Alt s'écrit ⌃⌥ (la touche Alt s'appelle Option).
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
// Raccourci « parler » choisi dans les réglages (message display) ; vide = désactivé.
let talkKeys = "Ctrl+Alt+F";
const L = (k: TextKey): string => {
  let s = (TEXTS[lang] ?? TEXTS.fr)[k] ?? TEXTS.fr[k];
  if (k === "faceTip") s = talkKeys ? s.replace("Ctrl+Alt+F", talkKeys) : "Floppy";
  return isMac ? s.replaceAll("Ctrl+Alt+", "⌃⌥") : s;
};
const isLang = (l: string): l is Lang => l === "fr" || l === "en";
const S = <K extends keyof (typeof SAID)["fr"]>(k: K) => (isLang(assistantLang) ? SAID[assistantLang] : SAID[lang] ?? SAID.fr)[k];
/** Texte { fr, en } (ou simple) dans la langue de l'assistant. */
const said = (x: unknown): string => {
  if (x && typeof x === "object") { const o = x as Record<string, string | undefined>; return o[assistantLang] ?? o[lang] ?? o.fr ?? ""; }
  return String(x ?? "");
};
function applyTexts() {
  document.documentElement.lang = lang;
  const listen = $("listen");
  if (listen?.lastChild?.nodeType === Node.TEXT_NODE) listen.lastChild.textContent = L("listen");
  $("faceWrap")?.setAttribute("title", L("faceTip"));
  const you = $("you")?.querySelector("b");
  if (you) you.textContent = L("you");
  // Cartes déjà affichées : leurs textes fixes changent de langue.
  for (const c of [...($("cards")?.children ?? [])] as CardEl[]) c._relabel?.();
}
function setLang(l: string): void {
  if (!isLang(l) || l === lang) return;
  lang = l;
  applyTexts();
}
// ------------------------------------------------------------------ avatar (plugin : plugins/avatar/<id>/renderer/index.js)
// Un avatar exporte create(container, { reducedMotion }) → { setState, setEmotion(name, intensity, ms), setLevel, destroy }
// et, s'il sait les montrer : setMood(valence, energy), lookAt(x, y) (-1..1), setHearing(niveau 0..1), cue(nom), resize.
// Le noyau envoie toujours les mêmes états et émotions ; `face` les garde et les rejoue sur l'avatar chargé.
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const motion = new AvatarMotion(reducedMotion);
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
    mod = await import(src);
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
  current.setAttention?.(approvals.size ? "approval" : last.state);
  if (last.mood) current.setMood?.(last.mood.valence, last.mood.energy);
  if (last.emotion) {
    const left = last.emotionUntil ? last.emotionUntil - performance.now() : 0;
    if (!last.emotionUntil || left > 0) current.setEmotion(last.emotion, last.intensity, last.emotionUntil ? left : undefined);
  }
  console.log(`avatar : ${id}`);
}
const host = window.floppyHost;

// ------------------------------------------------------------------ vie (commune à tous les avatars)
// Ce qui rend Floppy vivant sans le noyau : réactions quand on le touche, petites manies quand il s'ennuie,
// regard qui suit la souris. L'émotion du noyau reste prioritaire : une réaction locale est brève, puis
// l'émotion du noyau revient si elle est encore en cours.
const life: { kernel: { name: string; intensity: number | undefined; until: number; at: number }; activeAt: number; nextQuirk: number; pokes: number[]; lastPoke: string; flashTimer: number } = {
  kernel: { name: "neutral", intensity: undefined, until: 0, at: 0 }, // dernière émotion du noyau
  activeAt: performance.now(),  // dernière activité (état autre que repos, clic, émotion du noyau)
  nextQuirk: performance.now() + 20000,
  pokes: [],
  lastPoke: "",
  flashTimer: 0,
};
/** Émotion locale brève ; ensuite, l'émotion du noyau revient si elle est encore valable. */
function flash(name: string, ms: number, intensity: number): void {
  face.setEmotion(name, ms, intensity);
  clearTimeout(life.flashTimer);
  const at = life.kernel.at;
  life.flashTimer = setTimeout(() => {
    const k = life.kernel;
    if (k.at !== at || k.name === "neutral") return;
    const left = k.until ? k.until - performance.now() : 0;
    if (!k.until || left > 0) face.setEmotion(k.name, k.until ? left : undefined, k.intensity);
  }, ms);
}
const POKE_REACTIONS: [string, number, number][] = [["laugh", 1300, 1], ["shy", 1500, 1], ["wink", 900, 1], ["surprised", 800, 0.8], ["joy", 1200, 0.9], ["love", 1400, 0.8], ["mischief", 1100, 1]];
/** Un clic sur la tête : il rit, rougit, fait un clin d'œil… et finit par se fâcher si on insiste. */
function poke() {
  const now = performance.now();
  life.activeAt = now;
  life.pokes = life.pokes.filter((t) => now - t < 4000);
  life.pokes.push(now);
  face.cue("poke");
  const n = life.pokes.length;
  if (curState === "sleep") return flash("annoyed", 900, 0.5); // on le dérange : il grogne, sans se réveiller
  if (n >= 7) return flash("angry", 1600, 0.9);
  if (n >= 4) return flash("annoyed", 1400, 1);
  const choices = POKE_REACTIONS.filter(([name]) => name !== life.lastPoke);
  const [name, ms, i] = choices[Math.floor(Math.random() * choices.length)] ?? ["joy", 1200, 0.9];
  life.lastPoke = name;
  flash(name, ms, i);
}
/** Petites manies au repos : un regard ailleurs, un bâillement s'il est fatigué, un air malicieux… */
function quirk() {
  const energy = last.mood?.energy ?? 0.6;
  const alone = performance.now() - life.activeAt;
  const r = Math.random();
  if (energy < 0.35 && r < 0.5) return flash("tired", 1900, 1.2);                 // bâillement
  if (alone > 180000 && r < 0.35) return flash("bored", 2600, 0.7);
  if (r < 0.3) { face.lookAt(Math.random() * 2 - 1, Math.random() - 0.6); return; } // un coup d'œil ailleurs
  if (r < 0.45) return flash("curious", 1500, 0.6);
  if (r < 0.6) { flash("happy", 2200, 0.5); face.cue("nod"); return; }             // il chantonne dans sa tête
  if (r < 0.72) return flash("mischief", 900, 0.6);
  if (r < 0.82) return flash("wink", 650, 1);
  face.cue("perk");
}
setInterval(() => {
  const now = performance.now();
  if (curState !== "idle") { life.activeAt = now; return; }
  if (now < life.nextQuirk || now - life.kernel.at < 10000 || now - life.activeAt < 15000) return;
  life.nextQuirk = now + 15000 + Math.random() * 25000;
  if (!document.hidden) quirk();
}, 1000);
/** Position de la souris (px dans la fenêtre) → regard de l'avatar (-1..1 autour du visage). */
function lookAtPoint(x: number, y: number): void {
  const r = $("faceWrap")?.getBoundingClientRect();
  if (!r?.width) return;
  const dx = (x - (r.left + r.width / 2)) / (r.width * 1.2);
  const dy = (y - (r.top + r.height * 0.45)) / (r.height * 1.4);
  face.lookAt(Math.max(-1, Math.min(1, dx)), Math.max(-1, Math.min(1, dy)));
}
// Déplacer à la main, ou toucher : un appui sans bouger (moins de 5 px) est un clic sur la tête.
{
  const wrap = $("faceWrap");
  let press: { x: number; y: number; moved: boolean } | null = null;
  const stop = (e: PointerEvent, click: boolean) => {
    if (!press) return;
    if (press.moved) host?.drag?.("end");
    else if (click) poke();
    press = null;
    wrap.classList.remove("dragging");
    try { wrap.releasePointerCapture(e.pointerId); } catch { /* déjà relâché */ }
  };
  wrap?.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY, moved: false };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap?.addEventListener("pointermove", (e) => {
    if (!press) return;
    if (!press.moved && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
      press.moved = true;
      wrap.classList.add("dragging");
      host?.drag?.("start");
    }
    if (press.moved) host?.drag?.("move");
  });
  wrap?.addEventListener("pointerup", (e) => stop(e, true));
  wrap?.addEventListener("pointercancel", (e) => stop(e, false));
}

let port: MessagePort | null = null;
let micStarted = false;
let pttOn = false;
let dictating = false;
let lastLevelAt = 0;
let muted = false;
let replyText = "";
let hideTimer = 0;

// ------------------------------------------------------------------ bulle
let bubbleOn = true;
function showBubble() {
  if (!bubbleOn && !$("cards").children.length) return; // sans bulle, les cartes (accord, erreur) restent visibles
  clearTimeout(hideTimer);
  $("bubble").classList.remove("hide");
  const sc = $("scroll");
  requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
}
// État de Floppy vu par la bulle : on ne cache jamais la conversation tant qu'il parle, écoute ou réfléchit.
let curState = "sleep";
const atRest = () => curState === "idle" || curState === "sleep";
function hideBubbleSoon(ms = 9000) {
  clearTimeout(hideTimer);
  // Pas au repos : rien maintenant. Le retour au repos relance le minuteur (10 s).
  if (!atRest()) return;
  hideTimer = setTimeout(() => {
    if (!atRest()) return;
    // Seules les demandes d'accord retiennent la bulle (il faut y répondre). Les infos partent avec elle.
    if ($("cards").querySelector(".card.ask")) return;
    $("cards").querySelectorAll(".card:not(.ask)").forEach((c) => c.remove());
    $("bubble").classList.add("hide");
    setTimeout(() => { if ($("bubble").classList.contains("hide")) { $("you").textContent = ""; $("reply").textContent = ""; } }, 250);
  }, ms);
}
// « Je t'écoute… » : visible pendant l'écoute, tant qu'il n'a rien entendu de nouveau.
let listenShown = false;
function showListening(on: boolean): void {
  if (on === listenShown) return;
  listenShown = on;
  $("listen").hidden = !on;
  if (on) showBubble();
}
/** Il entend son nom : anneau autour du visage + petit saut, puis « Je t'écoute… ». */
let wokeTimer = 0;
function woke() {
  const w = $("faceWrap");
  w.classList.remove("woke");
  void w.offsetWidth; // relance l'animation
  w.classList.add("woke");
  clearTimeout(wokeTimer);
  wokeTimer = setTimeout(() => w.classList.remove("woke"), 750);
  if (curState !== "thinking" && curState !== "speaking") showListening(true);
}
function setYou(text: string): void {
  const you = $("you");
  you.textContent = "";
  const b = document.createElement("b"); b.textContent = L("you");
  you.append(b, document.createTextNode(text));
}

// Fenêtre transparente : les clics traversent les zones vides ; la tête et la bulle restent cliquables.
let interactive: boolean | null = null;
window.addEventListener("mousemove", (e) => {
  lookAtPoint(e.clientX, e.clientY);
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const hit = !!el?.closest("#bubble:not(.hide), #faceWrap");
  if (hit !== interactive) { interactive = hit; host?.setInteractive(hit); }
});
document.addEventListener("mouseleave", () => { if (interactive !== false) { interactive = false; host?.setInteractive(false); } });

/** Une carte. title et les libellés des boutons : un texte, ou une clé de TEXTS (suit la langue de l'interface). */
function card(kind: string, title: CardText, text: string, buttons?: { label: CardText; cls?: string; onClick: () => void }[]): CardEl {
  const el: CardEl = document.createElement("div");
  el.className = `card ${kind}`;
  const h = document.createElement("h3");
  const p = document.createElement("p"); p.textContent = text;
  el.append(h, p);
  const btns: [HTMLButtonElement, CardText][] = [];
  if (buttons) {
    const row = document.createElement("div"); row.className = "row";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = b.cls ?? "";
      btn.onclick = b.onClick;
      btns.push([btn, b.label]);
      row.append(btn);
    }
    el.append(row);
  }
  const txt = (x: CardText): string => (typeof x === "object" ? L(x.key as TextKey) : x);
  el._relabel = () => {
    h.textContent = txt(title);
    for (const [btn, label] of btns) btn.textContent = txt(label);
    if (kind !== "ask") el.title = L("closeTip");
  };
  el._relabel();
  // Info, erreur : une carte identique déjà affichée n'est pas répétée ; clic = fermer ; départ seul après 12 s.
  if (kind !== "ask") {
    const same = [...$("cards").querySelectorAll<CardEl>(`.card.${kind}`)].find((c) => c.textContent === el.textContent);
    if (same) { showBubble(); return same; }
    el.style.cursor = "pointer";
    el.addEventListener("click", () => { el.remove(); if (!$("cards").children.length) hideBubbleSoon(1500); });
    setTimeout(() => { el.remove(); if (!$("cards").children.length) hideBubbleSoon(1500); }, 12000);
  }
  $("cards").append(el);
  showBubble();
  return el;
}

// ------------------------------------------------------------------ voix (lecture)
const expressions = new SpeechExpressions();
const speechGestures = new SpeechExpressions<{ intent: SpeechGesture; intensity: number }>();
let speechPaused = false;
const play: { ctx: AudioContext | null; head: number; sources: Set<AudioBufferSourceNode>; analyser: AnalyserNode | null; gain: GainNode | null; playing: boolean } = { ctx: null, head: 0, sources: new Set(), analyser: null, gain: null, playing: false };
/** Contexte audio de lecture, créé au premier morceau de voix. */
function ensurePlay(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (play.ctx && play.analyser) return { ctx: play.ctx, analyser: play.analyser };
  const ctx = new AudioContext();
  play.ctx = ctx;
  ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  play.analyser = analyser;
  analyser.fftSize = 512;
  // Volume après l'analyseur : la bouche bouge pareil quand la voix est baissée.
  const gain = ctx.createGain();
  play.gain = gain;
  analyser.connect(gain);
  gain.connect(ctx.destination);
  return { ctx, analyser };
}
function playChunk(buf: ArrayBuffer): void {
  const { ctx, analyser } = ensurePlay();
  const u8 = new Uint8Array(buf);
  const rate = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  const n = (u8.byteLength - 4) >> 1;
  if (n <= 0) return;
  const pcm = new Int16Array(u8.slice(4).buffer, 0, n);
  const ab = ctx.createBuffer(1, n, rate);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (pcm[i] ?? 0) / 32768;
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(analyser);
  play.head = Math.max(play.head, ctx.currentTime + 0.04);
  src.start(play.head);
  expressions.audio(play.head);
  speechGestures.audio(play.head);
  play.head += ab.duration;
  play.sources.add(src);
  src.onended = () => play.sources.delete(src);
  if (!play.playing) { play.playing = true; send({ type: "playback", playing: true }); }
}
function stopPlayback() {
  expressions.clear();
  speechGestures.clear();
  face.setSpeechGesture(null);
  clearTimeout(life.flashTimer);
  life.kernel = { name: "neutral", intensity: 1, until: 0, at: performance.now() };
  face.setEmotion("neutral");
  face.setLevel(0);
  for (const s of play.sources) { try { s.stop(); } catch { /* déjà fini */ } }
  play.sources.clear();
  if (play.ctx) play.head = play.ctx.currentTime;
  setDuck(false);
}
/** Pause réversible : silence immédiat, sans perdre les mots si le micro a capté un écho. */
function setDuck(on: boolean): void {
  if (!play.gain || !play.ctx) return;
  if (speechPaused === on) return;
  speechPaused = on;
  play.gain.gain.setTargetAtTime(on ? 0 : 1, play.ctx.currentTime, 0.01);
  if (on) {
    face.setLevel(0);
    void play.ctx.suspend().catch(() => {});
  } else void play.ctx.resume().catch(() => {});
}
// Niveau de la voix → bouche ; fin de la file → playback:false.
const levelBuf = new Float32Array(512);
setInterval(() => {
  if (!play.ctx || !play.analyser) return;
  if (speechPaused) { face.setLevel(0); return; }
  expressions.tick(play.ctx.currentTime, (expression) => onMessage({ type: "emotion", ...expression }));
  face.setSpeechTime(play.ctx.currentTime);
  speechGestures.tick(play.ctx.currentTime, (gesture, at) => face.setSpeechGesture(gesture.intent, gesture.intensity, at));
  play.analyser.getFloatTimeDomainData(levelBuf);
  let s = 0;
  for (const v of levelBuf) s += v * v;
  face.setLevel(Math.min(1, Math.sqrt(s / levelBuf.length) * 5));
  if (play.playing && play.ctx.currentTime > play.head + 0.05) {
    play.playing = false;
    face.setLevel(0);
    face.setSpeechGesture(null);
    send({ type: "playback", playing: false });
  }
}, 33);

// ------------------------------------------------------------------ micro
const WORKLET = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === 512) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("mic", Mic);`;

async function startMic() {
  if (micStarted) return;
  micStarted = true;
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    const node = new AudioWorkletNode(ctx, "mic");
    let frames = 0, peak = 0, lastLog = performance.now();
    node.port.onmessage = (e) => {
      frames++;
      let sq = 0;
      for (const v of e.data) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
      // Ce qu'il entend : l'avatar réagit à la voix (seulement quand il écoute vraiment).
      const heard = muted || curState !== "listening" ? 0 : Math.min(1, Math.sqrt(sq / e.data.length) * 9);
      face.setHearing(heard);
      // Dictée : le niveau du micro anime la pilule (environ 20 fois par seconde).
      if (dictating && performance.now() - lastLevelAt > 50) { lastLevelAt = performance.now(); host?.dictationLevel?.(Math.min(1, Math.sqrt(sq / e.data.length) * 9)); }
      if (listenShown) $("listen").style.setProperty("--lvl", heard.toFixed(2));
      if (performance.now() - lastLog > 10000) {
        console.log(`micro : ${frames} trames en 10 s, crête ${peak.toFixed(3)}, contexte ${ctx.state}, port ${port ? "ok" : "absent"}`);
        frames = 0; peak = 0; lastLog = performance.now();
      }
      // Copie (pas de transfert de tampon : Electron abandonne ces messages vers le utilityProcess).
      if (port && (!muted || dictating)) port.postMessage({ a: e.data }); // la dictée écoute même quand Floppy dort
    };
    ctx.createMediaStreamSource(stream).connect(node);
    const track = stream.getAudioTracks()[0];
    console.log(`micro actif : « ${track?.label ?? "?"} », ${ctx.sampleRate} Hz, contexte ${ctx.state}`);
  } catch (e) {
    micStarted = false;
    console.log(`micro indisponible : ${errText(e)}`);
    card("error", { key: "micDown" }, errText(e));
  }
}

// ------------------------------------------------------------------ protocole
function send(msg: OutMsg): void { port?.postMessage({ j: msg }); }

const TOOLS = [
  // Ouvrir une page web : c'est le plugin « browser » (Réglages → Connecteurs), plus un outil de l'avatar.
  { name: "afficher_carte", description: "Affiche une carte à l'écran (titre et quelques lignes), pour une information longue. La réponse reste dite à voix haute.",
    inputSchema: { type: "object", properties: { titre: { type: "string" }, lignes: { type: "array", items: { type: "string" } } }, required: ["titre"] }, level: "read" },
  { name: "placer_avatar", description: "Déplace l'avatar de Floppy à l'écran (par ex. « remets-toi en place », « va en haut à gauche », « va sur l'écran 2 », « mets-toi sur ma fenêtre »). Sans précision : en bas à droite de l'écran principal, sa place habituelle.",
    inputSchema: { type: "object", properties: {
      coin: { type: "string", enum: ["bas_droite", "bas_gauche", "haut_droite", "haut_gauche", "centre"], description: "Où dans la zone. Par défaut bas_droite." },
      ecran: { type: "integer", minimum: 1, description: "Numéro d'écran : 1 = principal, puis de gauche à droite." },
      cible: { type: "string", enum: ["ecran", "fenetre"], description: "fenetre : dans la fenêtre active (celle où l'utilisateur travaille) au lieu de tout l'écran." },
    } }, level: "read" },
];

async function onToolCall(m: ToolCallMsg): Promise<void> {
  try {
    if (m.name === "afficher_carte") {
      card("info", String(m.args?.titre ?? ""), (m.args?.lignes ?? []).join("\n"));
      send({ type: "tool.result", callId: m.callId, ok: true, text: S("cardShown") });
    } else if (m.name === "placer_avatar" && host?.place) {
      // Réponse de l'app : { ok, text: { fr, en } } (ou une phrase, version plus ancienne).
      const r = await host.place(m.args ?? {});
      const ok = r && typeof r === "object" && "ok" in r ? r.ok !== false : true;
      send({ type: "tool.result", callId: m.callId, ok, text: said(r && typeof r === "object" && "ok" in r ? r.text : r) });
    } else send({ type: "tool.result", callId: m.callId, ok: false, text: S("unknownTool")(m.name) });
  } catch (e) {
    send({ type: "tool.result", callId: m.callId, ok: false, text: errText(e) });
  }
}

const approvals = new Map<string, CardEl>();
function onMessage(m: KernelMsg): void {
  switch (m.type) {
    case "welcome":
      if (typeof m.assistant?.language === "string") assistantLang = m.assistant.language.slice(0, 2).toLowerCase();
      startMic();
      break;
    case "state":
      curState = m.state;
      if (m.state !== "idle") life.activeAt = performance.now();
      face.setState(m.state);
      face.setAttention(approvals.size ? "approval" : m.state);
      host?.setState(m.state);
      if (m.state === "listening" || m.state === "thinking") { pttOn = pttOn && m.state === "listening"; }
      showListening(m.state === "listening");
      // De retour au repos : la conversation s'efface au bout de 10 s (sauf demande d'accord en cours).
      // Rien n'a été dit (seulement « Je t'écoute… ») : elle part tout de suite.
      if (m.state === "idle" || m.state === "sleep") hideBubbleSoon(!$("you").textContent && !$("reply").textContent ? 600 : 10000);
      else clearTimeout(hideTimer);
      break;
    case "emotion":
      if (m.nextAudio) { expressions.mark({ emotion: m.emotion, intensity: m.intensity, ms: m.ms }); break; }
      clearTimeout(life.flashTimer);
      life.kernel = { name: m.emotion, intensity: m.intensity, until: m.ms ? performance.now() + m.ms : 0, at: performance.now() };
      face.setEmotion(m.emotion, m.ms, m.intensity);
      break;
    case "speech.gesture":
      speechGestures.mark({ intent: m.intent, intensity: m.intensity });
      break;
    case "mood": face.setMood(m.valence, m.energy); break;
    case "cue":
      face.cue(m.cue);
      if (m.cue === "wake") woke();
      break;
    case "transcript":
      showListening(false);
      setYou(m.text); replyText = ""; $("reply").textContent = "";
      showBubble(); break;
    case "dictation": host?.dictation?.({ del: m.del, ins: m.ins }); break; // tapé dans la fenêtre active, pas de bulle
    case "reply.delta":
      replyText += m.text; $("reply").textContent = replyText.trim(); showBubble(); break;
    case "reply.done":
      if (m.text) $("reply").textContent = m.text;
      hideBubbleSoon(); break;
    case "interrupt": stopPlayback(); break;
    case "duck": setDuck(!!m.on); break;
    case "approval.request": {
      host?.activity("approval");
      const el = card("ask", { key: "ask" }, m.summary, [
        { label: { key: "yes" }, cls: "yes", onClick: () => send({ type: "approval.response", id: m.id, ok: true }) },
        { label: { key: "no" }, onClick: () => send({ type: "approval.response", id: m.id, ok: false }) },
      ]);
      const bar = document.createElement("div");
      bar.className = "ttl";
      bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: m.ttl_s * 1000, fill: "forwards" });
      el.append(bar);
      approvals.set(m.id, el);
      face.setAttention("approval");
      break;
    }
    case "approval.closed": {
      approvals.get(m.id)?.remove();
      approvals.delete(m.id);
      face.setAttention(approvals.size ? "approval" : curState);
      if (!approvals.size) host?.approvalClosed();
      if (!$("cards").children.length) hideBubbleSoon(4000);
      break;
    }
    case "tool.call": onToolCall(m); break;
    case "card": card("info", m.title, m.lines.join("\n")); break;
    case "panel": host?.openPanel?.(m); break;
    case "document": host?.openDocument?.(m); break;
    case "documents": host?.updateDocuments?.(m.liste); break;
    case "notify": card("info", { key: m.important ? "important" : "info" }, m.text); hideBubbleSoon(); break;
    case "error": card("error", { key: "error" }, m.text); break;
  }
}

function connect(p: MessagePort): void {
  if (port) { port.onmessage = null; stopPlayback(); }
  port?.close();
  port = p;
  // Nouvelle connexion : les anciennes demandes d'accord n'existent plus côté noyau. On retire les cartes
  // et on prévient l'app (sinon le masquage automatique reste bloqué).
  if (approvals.size) {
    for (const el of approvals.values()) el.remove();
    approvals.clear();
    host?.approvalClosed();
  }
  port.onmessage = (e) => {
    const d = e.data;
    if (d?.j) onMessage(d.j);
    else if (d?.a) playChunk(d.a);
  };
  port.start();
  send({ type: "hello", id: "avatar", name: "Avatar (bureau)", version: "0.1.0",
         capabilities: ["voice", "display", "emotion", "approval", "panel", "document", "speech_timing"], tools: TOOLS });
}

window.addEventListener("message", (e) => {
  if (e.data === "floppy:body-port" && e.ports[0]) connect(e.ports[0]);
  const disp = e.data?.floppyDisplay;
  if (disp) {
    if (typeof disp.raccourcis?.parler === "string" && disp.raccourcis.parler !== talkKeys) {
      talkKeys = disp.raccourcis.parler;
      $("faceWrap")?.setAttribute("title", L("faceTip"));
    }
    if (typeof disp.lang === "string") setLang(disp.lang);
    if (typeof disp.avatar === "string") void loadAvatar(disp.avatar, disp.avatarUrl);
    bubbleOn = disp.bulle !== false;
    document.body.classList.toggle("nobubble", !bubbleOn);
    if (!bubbleOn && !$("cards").children.length) $("bubble").classList.add("hide");
  }
  const docOpen = e.data?.floppyDocumentOpen;
  if (typeof docOpen === "string") send({ type: "document.open", id: docOpen });
  const docDel = e.data?.floppyDocumentDelete;
  if (docDel && typeof docDel.id === "string") send({ type: "document.delete", id: docDel.id, ...(docDel.current ? { current: docDel.current } : {}) });
  const cur = e.data?.floppyCursor;
  if (cur) lookAtPoint(cur.x, cur.y);
  const sc = e.data?.floppyShortcut;
  const request = e.data?.floppyTextRequest;
  if (typeof request === "string" && request.trim()) { muted = false; stopPlayback(); send({ type: "text", text: request }); }
  if (sc === "ptt-on" || sc === "ptt-off") { pttOn = sc === "ptt-on"; stopPlayback(); send({ type: "ptt", on: pttOn }); }
  if (sc === "dictate-on" || sc === "dictate-off") { dictating = sc === "dictate-on"; if (dictating) stopPlayback(); send({ type: "dictate", on: dictating }); }
  if (sc === "mute-on" || sc === "mute-off") { muted = sc === "mute-on"; send({ type: "mute", on: muted }); }
});
