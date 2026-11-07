// Champ « audio » de la fenêtre des réglages : enregistrer une voix au micro, ou importer un fichier.
// La phrase à lire est affichée ; à la fin, le son est nettoyé (silence aux bords), vérifié (durée, saturation, bruit),
// encodé en WAV 24 kHz et donné au formulaire en adresse data:audio/wav. Rien ne quitte l'ordinateur.
import { analyze, encodeWav, micChoices, micConstraints, RATE, trimSilence, waveBars, wavDataUrl } from "./audio-tools.ts";

/** Construit un élément (dom.ts). Méthode (et non propriété) : comparaison souple avec le `h` réel. */
interface Maker { (tag: string, props?: Record<string, unknown>, ...kids: unknown[]): HTMLElement }
type Tr = (text: unknown) => string;
interface MicChoice { value: string; label: string }
interface Prefs { mic: string; denoise: boolean }
interface Live {
  stream: MediaStream; ac: AudioContext; rec: MediaRecorder; elapsed: number; history: number[]; raf: number;
  ui: { timer: HTMLElement; meter: HTMLElement; wave: HTMLElement } | null;
}
/** État du champ, gardé par le formulaire entre deux dessins. */
export interface AudioState {
  mode?: "rec" | "file"; phase?: "idle" | "rec" | "busy" | "done"; prompt?: number; error?: string; url?: string;
  quality?: ReturnType<typeof analyze>; bars?: number[]; prefs?: Prefs;
  /** undefined : à relire ; null : lecture en cours. */
  mics?: MicChoice[] | null; live?: Live | null;
}
/** Champ « audio » du formulaire (descripteur venu du noyau). */
interface AudioFieldDef { prompts?: unknown[]; seconds?: { min: number; max: number } }
interface AudioDeps { h: Maker; t: (key: string) => string; tr: Tr; icon: (name: string) => Node; redraw: () => void; listenCurrent?: () => void }
interface AudioFieldArgs {
  f: AudioFieldDef; st: AudioState; value: unknown; set: (v: string) => void;
  setText: (text: string, prompts: string[]) => void; deps: AudioDeps;
}

/** Au-delà, l'enregistrement s'arrête tout seul (s). */
const HARD_MAX = 30;

// Micro choisi et réduction du bruit : un confort de cet ordinateur, gardé par la fenêtre (perdu sans gravité).
const PREFS = "floppy.voiceRecorder";
const loadPrefs = (): Partial<Prefs> => { try { return JSON.parse(localStorage.getItem(PREFS) ?? "{}") ?? {}; } catch { return {}; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify({ mic: p.mic, denoise: p.denoise })); } catch { /* rien */ } };

/** Relit la liste des micros (au premier dessin, après un enregistrement, quand on branche ou débranche un micro). */
async function refreshMics(st: AudioState, t: (key: string) => string, redraw: () => void) {
  st.mics = null; // lecture en cours
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    st.mics = micChoices(list, (n) => t("recMicN").replace("{n}", String(n)));
  } catch { st.mics = []; }
  navigator.mediaDevices.ondevicechange = () => { if (st.phase !== "rec") void refreshMics(st, t, redraw); };
  if (st.phase !== "rec") redraw();
}

/** Un fichier audio (n'importe quel format lu par la fenêtre) -> échantillons mono à 24 kHz. */
async function decode(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const ac = new AudioContext();
  try {
    const buf = await ac.decodeAudioData(arrayBuffer);
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * RATE)), RATE);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0).slice();
  } finally { void ac.close(); }
}

/**
 * Le champ. st : son état, gardé par le formulaire entre deux dessins (mode, phrase, enregistrement en cours, résultat).
 * deps : { h, t, tr, icon, redraw, listenCurrent? } ; set(valeur) ; setText(texte lu) ; prompts : phrases à lire.
 */
export function audioField({ f, st, value, set, setText, deps }: AudioFieldArgs): HTMLElement {
  const { h, t, tr, icon, redraw } = deps;
  const prompts: string[] = (f.prompts ?? []).map(tr).filter(Boolean);
  const aim = f.seconds ?? { min: 10, max: 20 };
  st.mode ??= "rec";
  st.phase ??= "idle";
  st.prompt ??= prompts.length ? Math.floor(Math.random() * prompts.length) : -1;
  const box = h("div", { class: "vrec", role: "group" });

  // 1. Comment : m'enregistrer, ou importer un fichier.
  const modeBtn = (id: "rec" | "file", label: string, ic: string) => h("button", {
    type: "button", role: "radio", "aria-checked": String(st.mode === id), class: st.mode === id ? "on" : "", disabled: st.phase === "rec" || st.phase === "busy",
    onclick: () => { st.mode = id; st.error = ""; redraw(); },
  }, icon(ic), label);
  box.append(h("div", { class: "seg vmode", role: "radiogroup", "aria-label": t("recHow") }, modeBtn("rec", t("recMe"), "mic"), modeBtn("file", t("recImport"), "upload")));

  // Enregistrement déjà gardé (modification d'une voix) : son nom, et « Écouter ».
  if (typeof value === "string" && value && !value.startsWith("data:") && st.phase === "idle") {
    box.append(h("div", { class: "vcur" },
      deps.listenCurrent ? h("button", { type: "button", class: "vplay", "aria-label": t("recListenCurrent"), onclick: deps.listenCurrent }, icon("play")) : null,
      h("span", { text: `${t("recCurrent")} : ${value.split(/[\\/]/).pop()}` }),
      h("span", { class: "hint", text: t("recReplaceHint") })));
  }

  const finish = async (raw: Float32Array, fromMic: boolean) => {
    const q = analyze(raw);
    const cut = trimSilence(raw);
    if (!cut.length) { st.phase = "idle"; st.error = t("recEmpty"); redraw(); return; }
    q.seconds = cut.length / RATE;
    const bytes = encodeWav(cut);
    if (st.url) URL.revokeObjectURL(st.url);
    st.url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    st.quality = q;
    st.bars = waveBars(cut, 96);
    st.phase = "done";
    st.error = "";
    set(wavDataUrl(bytes));
    const said = prompts[st.prompt ?? -1];
    if (fromMic && said) setText(said, prompts);
    redraw();
  };

  if (st.phase === "done") {
    // 3. Le résultat : réécouter, forme d'onde, vérifications, recommencer.
    const q = st.quality!;
    const secs = Math.round(q.seconds);
    const check = (ok: boolean, text: string) => h("li", { class: ok ? "ok" : "warn" }, icon(ok ? "check" : "triangle-alert"), h("span", { text }));
    const audio = new Audio(st.url);
    box.append(h("div", { class: "vpanel vdone" },
      h("button", { type: "button", class: "vplay", "aria-label": t("recReplay"), onclick: () => { audio.currentTime = 0; void audio.play(); } }, icon("play")),
      bars(h, st.bars ?? [], "vwave"),
      h("span", { class: "vsecs", text: `${secs} s` })));
    box.append(h("ul", { class: "vchecks", "aria-label": t("recChecks") },
      secs < aim.min ? check(false, t("recShort").replace("{n}", String(secs)).replace("{min}", String(aim.min)))
        : secs > aim.max + 10 ? check(false, t("recLong").replace("{n}", String(secs)).replace("{max}", String(aim.max)))
        : check(true, t("recLenOk").replace("{n}", String(secs))),
      q.clipped ? check(false, t("recClipped")) : check(true, t("recNotClipped")),
      q.tooQuiet ? check(false, t("recQuiet")) : null,
      q.noisy ? check(false, t("recNoisy")) : check(true, t("recClean"))));
    box.append(h("div", { class: "vacts" }, h("button", { type: "button", class: "btn small", onclick: () => { st.phase = "idle"; redraw(); } }, icon("rotate-ccw"), t("recAgain"))));
  } else if (st.mode === "file") {
    // 2b. Importer : n'importe quel format audio, converti ici.
    const input = h("input", { type: "file", accept: "audio/*", hidden: true }) as HTMLInputElement;
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      st.phase = "busy"; redraw();
      try { await finish(await decode(await file.arrayBuffer()), false); }
      catch { st.phase = "idle"; st.error = t("recBadFile"); redraw(); }
    });
    box.append(h("div", { class: "vpanel vfile" },
      h("button", { type: "button", class: "btn", disabled: st.phase === "busy", onclick: () => input.click() }, icon("upload"), st.phase === "busy" ? t("recReading") : t("recPickFile")),
      h("span", { class: "hint", text: t("recFileHint").replace("{min}", String(aim.min)).replace("{max}", String(aim.max)) }), input));
  } else {
    // 2a. M'enregistrer : le micro, la phrase à lire, puis le gros bouton.
    const prefs = (st.prefs ??= { mic: "default", denoise: true, ...loadPrefs() });
    if (st.mics === undefined) void refreshMics(st, t, redraw);
    const mics = st.mics ?? [];
    // Micro gardé mais débranché : on prend le premier de la liste (le « par défaut » du système).
    const mic = mics.some((m) => m.value === prefs.mic) ? prefs.mic : mics[0]?.value ?? "default";
    const idle = st.phase === "idle";
    const sel = h("select", { "aria-label": t("recMic"), disabled: !idle || !mics.length }) as HTMLSelectElement;
    for (const m of mics) sel.append(h("option", { value: m.value, text: m.label }));
    if (!mics.length) sel.append(h("option", { value: "", text: st.mics === null ? t("recMicLoading") : t("recNoMic") }));
    sel.value = mics.length ? mic : "";
    // « change » ne remonte pas : le formulaire en place enregistrerait la voix à chaque choix.
    sel.addEventListener("change", (e) => { e.stopPropagation(); prefs.mic = sel.value; savePrefs(prefs); });
    const dn = h("input", { type: "checkbox", checked: prefs.denoise !== false, disabled: !idle }) as HTMLInputElement;
    dn.addEventListener("change", (e) => { e.stopPropagation(); prefs.denoise = dn.checked; savePrefs(prefs); });
    box.append(h("div", { class: "vmic" }, icon("mic"), sel,
      h("label", { class: "vdenoise", title: t("recDenoiseHint") }, dn, h("span", { text: t("recDenoise") }))));
    if (prompts.length) {
      box.append(h("div", { class: "vprompt-h" },
        h("span", { class: "vlabel", text: t("recRead") }),
        h("button", { type: "button", class: "btn small", disabled: st.phase !== "idle", onclick: () => { st.prompt = ((st.prompt ?? 0) + 1) % prompts.length; redraw(); } }, icon("rotate-ccw"), t("recOther"))));
      box.append(h("blockquote", { class: "vprompt", text: `« ${prompts[st.prompt ?? 0]} »` }));
      box.append(h("div", { class: "hint", text: t("recKnown") }));
    }
    const live = st.live ?? null;
    const recording = st.phase === "rec";
    const timer = h("strong", { class: "vtime", text: recording ? clock(live?.elapsed ?? 0) : "0:00" });
    const meter = h("div", { class: "vmeter", role: "meter", "aria-label": t("recLevel"), "aria-valuemin": "0", "aria-valuemax": "1" }, h("i"));
    const wave = h("div", { class: "vwave live", "aria-hidden": "true" });
    if (live) { live.ui = { timer, meter, wave }; for (const b of live.history) wave.append(bar(h, b)); }
    const btn = h("button", {
      type: "button", class: `vbig${recording ? " on" : ""}`, disabled: st.phase === "busy",
      "aria-label": recording ? t("recStop") : t("recStart"),
      onclick: () => (recording ? stop(st) : start(st, { t, redraw, finish, max: Math.max(HARD_MAX, aim.max + 10), audio: micConstraints(mic, prefs.denoise !== false) })),
    }, icon(recording ? "square" : "mic"));
    box.append(h("div", { class: "vpanel" }, btn,
      h("div", { class: "vlive" },
        h("div", { class: "vtop" }, timer, h("span", { class: "hint", text: recording ? t("recOn") : st.phase === "busy" ? t("recReading") : t("recAim").replace("{min}", String(aim.min)).replace("{max}", String(aim.max)) })),
        wave, meter)));
    box.append(h("ol", { class: "vtips" }, h("li", { text: t("recTip1") }), h("li", { text: t("recTip2") }), h("li", { text: t("recTip3") })));
  }
  if (st.error) box.append(h("div", { class: "vbad", role: "alert", text: st.error }));
  box.append(h("div", { class: "hint", text: t("recLocal") }));
  return box;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const bar = (h: Maker, x: number) => { const b = h("span"); b.style.height = `${Math.max(3, Math.round(x * 100))}%`; return b; };
function bars(h: Maker, list: number[], cls: string) {
  const w = h("div", { class: cls, "aria-hidden": "true" });
  for (const x of list) w.append(bar(h, x));
  return w;
}

/** Démarre le micro : niveau, minuteur et forme d'onde en direct, sans redessiner le formulaire. */
interface StartOpts {
  t: (key: string) => string; redraw: () => void; finish: (raw: Float32Array, fromMic: boolean) => Promise<void>;
  max: number; audio: MediaTrackConstraints;
}
async function start(st: AudioState, { t, redraw, finish, max, audio }: StartOpts) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    // Micro choisi introuvable (débranché entre-temps) : on relit la liste.
    const name = e instanceof Error ? e.name : "";
    if (name === "OverconstrainedError") { st.mics = undefined; st.error = t("recMicGone"); redraw(); return; }
    st.error = name === "NotFoundError" ? t("recNoMic") : t("recDenied");
    redraw();
    return;
  }
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(stream).connect(an);
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const live: Live = { stream, ac, rec, elapsed: 0, history: [], ui: null, raf: 0 };
  st.live = live;
  st.phase = "rec";
  st.error = "";
  rec.onstop = async () => {
    cancelAnimationFrame(live.raf);
    for (const tr of stream.getTracks()) tr.stop();
    void ac.close();
    st.live = null;
    st.phase = "busy";
    st.mics = undefined; // le micro est autorisé maintenant : les noms des micros sont connus
    redraw();
    try { await finish(await decode(await new Blob(chunks).arrayBuffer()), true); }
    catch { st.phase = "idle"; st.error = t("recBadFile"); redraw(); }
  };
  rec.start(250);
  const buf = new Float32Array(an.fftSize);
  const t0 = performance.now();
  let lastBar = 0;
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    live.elapsed = (performance.now() - t0) / 1000;
    if (live.elapsed - lastBar >= 0.1) { lastBar = live.elapsed; live.history.push(level); live.ui?.wave.append(bar(((tag: string) => document.createElement(tag)) as Maker, level)); }
    if (live.ui) {
      live.ui.timer.textContent = clock(live.elapsed);
      (live.ui.meter.firstChild as HTMLElement).style.transform = `scaleX(${level.toFixed(3)})`;
      live.ui.meter.setAttribute("aria-valuenow", level.toFixed(2));
    }
    if (live.elapsed >= max) { stop(st); return; }
    live.raf = requestAnimationFrame(tick);
  };
  redraw();
  live.raf = requestAnimationFrame(tick);
}

function stop(st: AudioState) {
  if (st.live?.rec.state === "recording") st.live.rec.stop();
}

/** Arrête un enregistrement en cours (fermeture du formulaire). */
export function abortRecording(st: AudioState | null | undefined) {
  const live = st?.live;
  if (!live) return;
  live.rec.onstop = null;
  if (live.rec.state === "recording") live.rec.stop();
  cancelAnimationFrame(live.raf);
  for (const tr of live.stream.getTracks()) tr.stop();
  void live.ac.close();
  st.live = null;
  st.phase = "idle";
}
