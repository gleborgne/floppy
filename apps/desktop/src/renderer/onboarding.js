// Fenêtre « Bienvenue » (premier lancement) : la machine, le niveau, le cerveau cloud si besoin, puis l'installation.
// Tout vient du noyau (window.floppyOnboarding) ; seuls les textes de la fenêtre sont ici (fr / en).
// Tout texte venu du noyau est inséré avec textContent : jamais de innerHTML.
import { tr, gb, MANUAL_CHOICES, needsManual, stepsFor, machineRows, levelFacts, rowStatus, defaultLevel } from "./onboarding-view.js";

const api = window.floppyOnboarding;
const $ = (id) => document.getElementById(id);
const GIB = 1024 ** 3;

const I = {
  fr: {
    title: "Bienvenue", steps: "Étapes",
    machineTitle: "Ta machine", machineLead: "Floppy regarde ta machine pour choisir les modèles qui y tiennent.",
    looking: "Je regarde ta machine…", chip: "Puce graphique", memoryKind: "Mémoire", unified: "unifiée (partagée avec le processeur)",
    dedicated: "propre à la carte", forModels: "Pour les modèles", noChip: "aucune puce graphique utile", ram: "RAM", disk: "Place libre",
    manual: "Je n'ai rien pu lire. Combien de mémoire a ta carte graphique ?", manualNone: "Pas de carte",
    agents: "Programmes de cerveau", found: "trouvé", notFound: "pas installé", reread: "Relire la machine",
    home: "Dossier de Floppy", homeHint: "Floppy y garde tout : config, réglages, modèles, espaces de travail des agents, plugins, journaux.",
    homeChange: "Changer…", homeMoving: "Floppy repart dans le nouveau dossier…",
    levelTitle: "Choisis ton niveau",
    levelLead: "C'est toi qui choisis. Le niveau conseillé est le plus complet qui tient dans ta machine, mais tu peux prendre plus léger : moins à télécharger, et tu pourras monter plus tard (Réglages → Général). Un niveau marqué en jaune ne tient pas : tu peux le choisir quand même.",
    recommended: "Conseillé", toDownload: "À télécharger :", nothingToDownload: "Rien à télécharger", forced: "Ce niveau ne tient pas dans ta machine : il risque d'être lent ou de ne pas démarrer.",
    brainTitle: "Le cerveau dans le cloud", brainLead: "Floppy pense avec ce service. Tes demandes partent dans le cloud.",
    toAdd: "trouvé sur ta machine : sera ajouté", programMissing: "programme introuvable",
    noBrain: "Aucun cerveau dans le cloud n'est prêt. Installe Claude Code, Codex ou Antigravity, ou ajoute une clé dans les réglages.",
    openSettings: "Ouvrir les réglages",
    installTitle: "Installation", installLead: "Les modèles se téléchargent. Chaque morceau s'active dès qu'il est prêt. Tu peux fermer cette fenêtre : tout continue, et tu suis l'avancement dans Réglages → Général.",
    liveTitle: "Floppy marche déjà", liveLead: "Tu peux lui écrire dès maintenant. Le reste s'active dès qu'il est téléchargé. Tu peux fermer cette fenêtre : tout continue, et tu suis l'avancement dans Réglages → Général.",
    testing: "Test de vitesse du cerveau…", doneTitle: "Floppy est prêt", errorTitle: "Quelque chose a échoué",
    skip: "Passer", back: "Retour", next: "Continuer", install: "Installer", finish: "Terminer", other: "Choisir un autre niveau",
    downloading: "téléchargement…", ready: "Prêt", failed: "Échec", waiting: "En attente",
    roles: { vad: "Détecteur de parole", stt: "Transcription", tts: "Voix", llm: "Cerveau", program: "Programme" },
    noApi: "Cette fenêtre s'ouvre depuis l'appli Floppy.",
  },
  en: {
    title: "Welcome", steps: "Steps",
    machineTitle: "Your computer", machineLead: "Floppy looks at your computer to pick models that fit in it.",
    looking: "Looking at your computer…", chip: "Graphics chip", memoryKind: "Memory", unified: "unified (shared with the processor)",
    dedicated: "on the card", forModels: "For models", noChip: "no usable graphics chip", ram: "RAM", disk: "Free space",
    manual: "I could not read anything. How much memory does your graphics card have?", manualNone: "No card",
    agents: "Brain programs", found: "found", notFound: "not installed", reread: "Read the computer again",
    home: "Floppy's folder", homeHint: "Floppy keeps everything there: config, settings, models, agents' workspaces, plugins, logs.",
    homeChange: "Change…", homeMoving: "Floppy is restarting in the new folder…",
    levelTitle: "Choose your level",
    levelLead: "You choose. The recommended level is the most complete one that fits in your computer, but you can take a lighter one: less to download, and you can go up later (Settings → General). A level marked in yellow does not fit: you can still choose it.",
    recommended: "Recommended", toDownload: "To download:", nothingToDownload: "Nothing to download", forced: "This level does not fit in your computer: it may be slow or fail to start.",
    brainTitle: "The brain in the cloud", brainLead: "Floppy thinks with this service. Your requests go to the cloud.",
    toAdd: "found on your computer: will be added", programMissing: "program not found",
    noBrain: "No cloud brain is ready. Install Claude Code, Codex or Antigravity, or add a key in the settings.",
    openSettings: "Open the settings",
    installTitle: "Installation", installLead: "The models are downloading. Each part turns on as soon as it is ready. You can close this window: everything goes on, and you can follow it in Settings → General.",
    liveTitle: "Floppy already works", liveLead: "You can write to it right now. The rest turns on as soon as it is downloaded. You can close this window: everything goes on, and you can follow it in Settings → General.",
    testing: "Testing the brain's speed…", doneTitle: "Floppy is ready", errorTitle: "Something failed",
    skip: "Skip", back: "Back", next: "Continue", install: "Install", finish: "Finish", other: "Choose another level",
    downloading: "downloading…", ready: "Ready", failed: "Failed", waiting: "Waiting",
    roles: { vad: "Speech detector", stt: "Transcription", tts: "Voice", llm: "Brain", program: "Program" },
    noApi: "This window opens from the Floppy app.",
  },
};
let lang = "fr";
const t = (k) => I[lang]?.[k] ?? I.fr[k] ?? k;

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) e.append(c);
  return e;
}

// ------------------------------------------------------------------ état de la fenêtre
let plan = null;        // machine, niveaux, cerveaux cloud, programmes trouvés
let step = "machine";
let level = null;       // id du niveau choisi
let brain = null;       // valeur du cerveau cloud choisi (« add:<plugin> » : à ajouter)
let manual = null;      // Go choisis à la main (rien n'a été lu)
let inst = null;        // avancement de l'installation (onboarding.state)
let error = "";
let busy = false;

const chosenLevel = () => plan?.levels.find((l) => l.id === level);
const steps = () => stepsFor(chosenLevel());

async function load(opts = {}) {
  busy = true; error = ""; render();
  const r = await api.plan(opts);
  busy = false;
  if (!r?.ok) { error = tr(r?.text, lang) || t("failed"); render(); return; }
  plan = r.value;
  if (plan.lang && I[plan.lang]) { lang = plan.lang; document.documentElement.lang = lang; }
  if (!level || !plan.levels.some((l) => l.id === level)) level = defaultLevel(plan);
  if (!brain || !brainChoices().some((b) => b.value === brain && !b.off)) brain = plan.brain ?? null;
  // Fenêtre rouverte pendant une installation : on revient à l'avancement.
  if (plan.state && plan.state.phase !== "idle") { inst = plan.state; step = "install"; }
  render();
}

/** Cerveaux cloud à proposer : déjà offerts (grisés si leur programme manque), puis programmes trouvés à ajouter. */
function brainChoices() {
  if (!plan) return [];
  const out = plan.cloudBrains.map((c) => ({ value: c.value, label: c.label, note: c.found === false ? t("programMissing") : "", off: c.found === false }));
  for (const a of plan.agents ?? []) {
    if (a.found && !a.entries.length && a.section === "cerveau") out.push({ value: `add:${a.plugin}`, label: a.label, note: t("toAdd"), off: false });
  }
  return out;
}

// ------------------------------------------------------------------ pages
function machinePage() {
  const nodes = [h("h2", { text: t("machineTitle") }), h("p", { class: "lead", text: t("machineLead") })];
  if (!plan) {
    nodes.push(h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("looking") })));
    return nodes;
  }
  nodes.push(h("div", { class: "card" }, machineRows(plan.machine, t, lang).map(([k, v]) => h("div", { class: "row" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: v })))));
  if (needsManual(plan)) {
    nodes.push(h("p", { class: "label", text: t("manual") }));
    nodes.push(h("div", { class: "seg", role: "radiogroup", "aria-label": t("manual") }, MANUAL_CHOICES.map((g) => h("button", {
      type: "button", role: "radio", "aria-checked": String(manual === g),
      text: g === 0 ? t("manualNone") : gb(g * GIB, lang),
      onclick: () => { manual = g; void load({ manualBytes: g * GIB }); },
    }))));
  }
  // Répertoire de travail : tout ce que Floppy garde (et tout ce qu'il va télécharger) va là.
  if (plan.home) {
    nodes.push(h("p", { class: "label", text: t("home") }));
    nodes.push(h("div", { class: "card" }, h("div", { class: "row home" },
      h("span", { class: "path", text: plan.home }),
      h("span", { class: "v" }, h("button", { type: "button", class: "btn small", text: t("homeChange"), disabled: busy || !api.chooseHome, onclick: () => void chooseHome() })))));
    nodes.push(h("p", { class: "hint", text: t("homeHint") }));
  }
  if (plan.agents?.length) {
    nodes.push(h("p", { class: "label", text: t("agents") }));
    nodes.push(h("div", { class: "card" }, plan.agents.map((a) => h("div", { class: "row" },
      h("span", { class: "k", text: tr(a.label, lang) }),
      h("span", { class: "v" }, h("span", { class: a.found ? "chip" : "chip warn", text: a.found ? t("found") : t("notFound") }))))));
  }
  return nodes;
}

function levelPage() {
  const nodes = [h("h2", { text: t("levelTitle") }), h("p", { class: "lead", text: t("levelLead") })];
  nodes.push(h("div", { class: "choices", role: "radiogroup", "aria-label": t("levelTitle") }, plan.levels.map((l) => {
    const f = levelFacts(l, t, lang);
    return h("button", {
      type: "button", role: "radio", class: l.possible ? "choice" : "choice off", "aria-checked": String(level === l.id),
      onclick: () => { level = l.id; render(); },
    },
    h("span", { class: "name" }, h("span", { text: tr(l.label, lang) }), l.id === plan.recommended ? h("span", { class: "chip", text: t("recommended") }) : null),
    h("span", { class: "desc", text: tr(l.description, lang) }),
    f.models ? h("span", { class: "facts", text: f.models }) : null,
    h("span", { class: f.warn ? "note warn" : "note", text: f.note }));
  })));
  if (chosenLevel() && !chosenLevel().possible) nodes.push(h("p", { class: "hint", text: t("forced") }));
  return nodes;
}

function brainPage() {
  const nodes = [h("h2", { text: t("brainTitle") }), h("p", { class: "lead", text: t("brainLead") })];
  const list = brainChoices();
  if (!list.some((b) => !b.off)) {
    nodes.push(h("p", { class: "hint", text: t("noBrain") }));
    nodes.push(h("button", { type: "button", class: "btn", text: t("openSettings"), onclick: () => api.openSettings() }));
  }
  if (list.length) {
    nodes.push(h("div", { class: "choices", role: "radiogroup", "aria-label": t("brainTitle") }, list.map((b) => h("button", {
      type: "button", role: "radio", class: b.off ? "choice off" : "choice", "aria-checked": String(brain === b.value), disabled: b.off,
      onclick: () => { brain = b.value; render(); },
    }, h("span", { class: "name", text: tr(b.label, lang) }), b.note ? h("span", { class: b.off ? "note warn" : "note", text: b.note }) : null))));
  }
  return nodes;
}

function installPage() {
  const s = inst ?? { phase: "installing", rows: [], notes: [] };
  const running = s.phase === "installing" || s.phase === "testing";
  const title = s.phase === "done" ? t("doneTitle") : s.phase === "error" ? t("errorTitle") : s.live ? t("liveTitle") : t("installTitle");
  const nodes = [h("h2", { text: title })];
  if (running) nodes.push(h("p", { class: "lead", text: s.live ? t("liveLead") : t("installLead") }));
  if (s.phase === "testing") nodes.push(h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("testing") })));
  if (s.rows.length) {
    nodes.push(h("div", { class: "card" }, s.rows.map((r) => {
      const pct = Math.floor((r.progress ?? (r.state === "ready" ? 1 : 0)) * 100);
      const fill = h("i");
      fill.style.transform = `scaleX(${pct / 100})`;
      return h("div", { class: "irow" },
        h("div", {}, h("div", { class: "nm", text: tr(r.label, lang) }), h("div", { class: "role", text: t("roles")[r.role] ?? r.role })),
        h("div", { class: "prog" },
          h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": tr(r.label, lang) }, fill),
          h("span", { class: r.state === "ready" ? "st ok" : r.state === "error" ? "st bad" : "st", text: rowStatus(r, t, lang) })));
    })));
  }
  if (s.notes.length) nodes.push(h("ul", { class: "notes" }, s.notes.map((n) => h("li", { text: tr(n, lang) }))));
  return nodes;
}

// ------------------------------------------------------------------ actions
/** Nouveau répertoire de travail : le noyau repart dans ce dossier ; on relit le plan quand il répond de nouveau. */
async function chooseHome() {
  error = "";
  const r = await api.chooseHome();
  if (!r || r.canceled) return;
  if (!r.ok) { error = tr(r.text, lang) || t("failed"); render(); return; }
  busy = true; plan = null; render();
  $("content").replaceChildren(h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("homeMoving") })));
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const next = await api.plan({});
    if (next?.ok) { busy = false; await load({}); return; }
  }
  busy = false;
  await load({});
}

async function install() {
  busy = true; error = ""; render();
  // Le cerveau cloud sert au niveau « cloud », et de secours si le cerveau local est trop lent.
  const r = await api.apply(level, brain);
  busy = false;
  if (!r?.ok) { error = tr(r?.text, lang) || t("failed"); render(); return; }
  step = "install";
  render();
}

function go(delta) {
  const list = steps();
  const i = list.indexOf(step) + delta;
  if (i < 0) return;
  if (list[i] === "install") { void install(); return; }
  step = list[i];
  render();
  // Le niveau (ou le cerveau) choisi peut être plus bas : on le montre.
  document.querySelector('.choice[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
}

function actions() {
  const out = [];
  const btn = (text, onclick, pri, disabled) => h("button", { type: "button", class: pri ? "btn pri" : "btn", text, onclick, disabled: disabled || busy });
  if (step === "install") {
    const phase = inst?.phase;
    if (phase === "error") { out.push(btn(t("other"), () => { step = "level"; inst = null; void load({}); })); out.push(h("span", { class: "grow" })); out.push(btn(t("finish"), () => api.close(), true)); }
    else { out.push(h("span", { class: "grow" })); out.push(btn(t("finish"), () => api.close(), phase === "done" || inst?.live === true)); }
    return out;
  }
  out.push(btn(t("skip"), async () => { await api.skip(); api.close(); }));
  if (step === "machine") out.push(btn(t("reread"), () => void load({ fresh: true })));
  out.push(h("span", { class: "grow" }));
  if (step !== "machine") out.push(btn(t("back"), () => go(-1)));
  const list = steps();
  const last = list[list.indexOf(step) + 1] === "install";
  const blocked = !plan || (step === "brain" && !brain);
  out.push(btn(last ? t("install") : t("next"), () => go(1), true, blocked));
  return out;
}

function render() {
  document.title = `Floppy — ${t("title")}`;
  $("title").textContent = t("title");
  const list = steps();
  const cur = list.indexOf(step);
  $("steps").setAttribute("aria-label", t("steps"));
  $("steps").replaceChildren(...list.map((s, i) => h("li", { class: i < cur ? "done" : "", ...(i === cur ? { "aria-current": "step" } : {}) })));
  const page = !api ? [h("p", { class: "lead", text: t("noApi") })]
    : step === "machine" || !plan ? machinePage()
    : step === "level" ? levelPage()
    : step === "brain" ? brainPage()
    : installPage();
  if (error) page.push(h("p", { class: "hint", role: "alert", text: error }));
  $("content").replaceChildren(...page);
  $("actions").replaceChildren(...(api ? actions() : []));
}

if (api) {
  api.onState((s) => { inst = s; if (step === "install") render(); });
  void load({});
}
render();
