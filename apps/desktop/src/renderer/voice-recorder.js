// Champ « audio » de la fenêtre des réglages : enregistrer une voix au micro, ou importer un fichier.
// La phrase à lire est affichée ; à la fin, le son est nettoyé (silence aux bords), vérifié (durée, saturation, bruit),
// encodé en WAV 24 kHz et donné au formulaire en adresse data:audio/wav. Rien ne quitte l'ordinateur.
import { analyze, encodeWav, RATE, trimSilence, waveBars, wavDataUrl } from "./audio-tools.js";

/** Au-delà, l'enregistrement s'arrête tout seul (s). */
const HARD_MAX = 30;

/** Un fichier audio (n'importe quel format lu par la fenêtre) -> échantillons mono à 24 kHz. */
async function decode(arrayBuffer) {
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
export function audioField({ f, st, value, set, setText, deps }) {
  const { h, t, tr, icon, redraw } = deps;
  const prompts = (f.prompts ?? []).map(tr).filter(Boolean);
  const aim = f.seconds ?? { min: 10, max: 20 };
  st.mode ??= "rec";
  st.phase ??= "idle";
  st.prompt ??= prompts.length ? Math.floor(Math.random() * prompts.length) : -1;
  const box = h("div", { class: "vrec", role: "group" });

  // 1. Comment : m'enregistrer, ou importer un fichier.
  const modeBtn = (id, label, ic) => h("button", {
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

  const finish = async (raw, fromMic) => {
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
    if (fromMic && prompts[st.prompt]) setText(prompts[st.prompt], prompts);
    redraw();
  };

  if (st.phase === "done") {
    // 3. Le résultat : réécouter, forme d'onde, vérifications, recommencer.
    const q = st.quality;
    const secs = Math.round(q.seconds);
    const check = (ok, text) => h("li", { class: ok ? "ok" : "warn" }, icon(ok ? "check" : "triangle-alert"), h("span", { text }));
    const audio = new Audio(st.url);
    box.append(h("div", { class: "vpanel vdone" },
      h("button", { type: "button", class: "vplay", "aria-label": t("recReplay"), onclick: () => { audio.currentTime = 0; void audio.play(); } }, icon("play")),
      bars(h, st.bars, "vwave"),
      h("span", { class: "vsecs", text: `${secs} s` })));
    box.append(h("ul", { class: "vchecks", "aria-label": t("recChecks") },
      secs < aim.min ? check(false, t("recShort").replace("{n}", secs).replace("{min}", aim.min))
        : secs > aim.max + 10 ? check(false, t("recLong").replace("{n}", secs).replace("{max}", aim.max))
        : check(true, t("recLenOk").replace("{n}", secs)),
      q.clipped ? check(false, t("recClipped")) : check(true, t("recNotClipped")),
      q.tooQuiet ? check(false, t("recQuiet")) : null,
      q.noisy ? check(false, t("recNoisy")) : check(true, t("recClean"))));
    box.append(h("div", { class: "vacts" }, h("button", { type: "button", class: "btn small", onclick: () => { st.phase = "idle"; redraw(); } }, icon("rotate-ccw"), t("recAgain"))));
  } else if (st.mode === "file") {
    // 2b. Importer : n'importe quel format audio, converti ici.
    const input = h("input", { type: "file", accept: "audio/*", hidden: true });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      st.phase = "busy"; redraw();
      try { await finish(await decode(await file.arrayBuffer()), false); }
      catch { st.phase = "idle"; st.error = t("recBadFile"); redraw(); }
    });
    box.append(h("div", { class: "vpanel vfile" },
      h("button", { type: "button", class: "btn", disabled: st.phase === "busy", onclick: () => input.click() }, icon("upload"), st.phase === "busy" ? t("recReading") : t("recPickFile")),
      h("span", { class: "hint", text: t("recFileHint").replace("{min}", aim.min).replace("{max}", aim.max) }), input));
  } else {
    // 2a. M'enregistrer : la phrase à lire, puis le gros bouton.
    if (prompts.length) {
      box.append(h("div", { class: "vprompt-h" },
        h("span", { class: "vlabel", text: t("recRead") }),
        h("button", { type: "button", class: "btn small", disabled: st.phase !== "idle", onclick: () => { st.prompt = (st.prompt + 1) % prompts.length; redraw(); } }, icon("rotate-ccw"), t("recOther"))));
      box.append(h("blockquote", { class: "vprompt", text: `« ${prompts[st.prompt]} »` }));
      box.append(h("div", { class: "hint", text: t("recKnown") }));
    }
    const live = st.live;
    const recording = st.phase === "rec";
    const timer = h("strong", { class: "vtime", text: recording ? clock(live.elapsed) : "0:00" });
    const meter = h("div", { class: "vmeter", role: "meter", "aria-label": t("recLevel"), "aria-valuemin": "0", "aria-valuemax": "1" }, h("i"));
    const wave = h("div", { class: "vwave live", "aria-hidden": "true" });
    if (live) { live.ui = { timer, meter, wave }; for (const b of live.history) wave.append(bar(h, b)); }
    const btn = h("button", {
      type: "button", class: `vbig${recording ? " on" : ""}`, disabled: st.phase === "busy",
      "aria-label": recording ? t("recStop") : t("recStart"),
      onclick: () => (recording ? stop(st) : start(st, { t, redraw, finish, max: Math.max(HARD_MAX, aim.max + 10) })),
    }, icon(recording ? "square" : "mic"));
    box.append(h("div", { class: "vpanel" }, btn,
      h("div", { class: "vlive" },
        h("div", { class: "vtop" }, timer, h("span", { class: "hint", text: recording ? t("recOn") : st.phase === "busy" ? t("recReading") : t("recAim").replace("{min}", aim.min).replace("{max}", aim.max) })),
        wave, meter)));
    box.append(h("ol", { class: "vtips" }, h("li", { text: t("recTip1") }), h("li", { text: t("recTip2") }), h("li", { text: t("recTip3") })));
  }
  if (st.error) box.append(h("div", { class: "vbad", role: "alert", text: st.error }));
  box.append(h("div", { class: "hint", text: t("recLocal") }));
  return box;
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const bar = (h, x) => { const b = h("span"); b.style.height = `${Math.max(3, Math.round(x * 100))}%`; return b; };
function bars(h, list, cls) {
  const w = h("div", { class: cls, "aria-hidden": "true" });
  for (const x of list) w.append(bar(h, x));
  return w;
}

/** Démarre le micro : niveau, minuteur et forme d'onde en direct, sans redessiner le formulaire. */
async function start(st, { t, redraw, finish, max }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  } catch (e) {
    st.error = e?.name === "NotFoundError" ? t("recNoMic") : t("recDenied");
    redraw();
    return;
  }
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 2048;
  ac.createMediaStreamSource(stream).connect(an);
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const live = { stream, ac, rec, elapsed: 0, history: [], ui: null, raf: 0 };
  st.live = live;
  st.phase = "rec";
  st.error = "";
  rec.onstop = async () => {
    cancelAnimationFrame(live.raf);
    for (const tr of stream.getTracks()) tr.stop();
    void ac.close();
    st.live = null;
    st.phase = "busy";
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
    if (live.elapsed - lastBar >= 0.1) { lastBar = live.elapsed; live.history.push(level); live.ui?.wave.append(bar((tag) => document.createElement(tag), level)); }
    if (live.ui) {
      live.ui.timer.textContent = clock(live.elapsed);
      live.ui.meter.firstChild.style.transform = `scaleX(${level.toFixed(3)})`;
      live.ui.meter.setAttribute("aria-valuenow", level.toFixed(2));
    }
    if (live.elapsed >= max) { stop(st); return; }
    live.raf = requestAnimationFrame(tick);
  };
  redraw();
  live.raf = requestAnimationFrame(tick);
}

function stop(st) {
  if (st.live?.rec.state === "recording") st.live.rec.stop();
}

/** Arrête un enregistrement en cours (fermeture du formulaire). */
export function abortRecording(st) {
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
