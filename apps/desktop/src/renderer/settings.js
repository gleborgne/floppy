// Fenêtre des réglages : tout est généré depuis ce que les plugins déclarent (réglages du registre + fournisseurs
// d'éléments du catalogue, rubriques comprises). Aucune liste en dur : seuls les textes de la fenêtre sont ici (fr / en).
// Sans window.floppySettings (ouverture hors de l'app), la page charge des données d'exemple (settings-demo.js).
// Tout texte venu du noyau est inséré avec textContent : jamais de innerHTML.
import { initAssistant } from "./assistant.js";
import { entryOf, offersOf, slotSources } from "./slot-sources.js";
import { isLight } from "./tab-rules.js";
import { listAdd, missingFields as missingOf, chainOf } from "./form-rules.js";
import { splitLibraries, librariesFor, downloadSummary, libraryShape, percent } from "./library.js";
import { installSummary, rowStatus } from "./onboarding-view.js";

const api = window.floppySettings;
const SECRET_SET = "__secret_set__";
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ textes de la fenêtre (fr / en)
const I = {
  fr: {
    title: "Réglages", firstSetup: "Refaire le réglage de départ",
    onbTitle: "Installation de départ", onbRunning: "en cours", onbDone: "terminée", onbFailed: "un morceau a échoué",
    onbOf: "prêts sur", onbDownloading: "téléchargement…", onbReady: "Prêt", onbWaiting: "En attente", onbFailedRow: "Échec",
    onbRoles: { vad: "Détecteur de parole", stt: "Transcription", tts: "Voix", llm: "Cerveau", program: "Programme" }, search: "Chercher un réglage, un plugin, un outil…", searchLabel: "Chercher un réglage",
    undo: "Annuler le dernier changement", assistant: "Assistant IA", navLabel: "Rubriques",
    navNote: "Chaque rubrique se construit avec les plugins installés. Un nouveau plugin y ajoute ses options.",
    add: "Ajouter", addIn: "Ajouter", addTitle: "Ajouter", editTitle: "Modifier", cancel: "Annuler", close: "Fermer", save: "Enregistrer",
    addAndGo: "Ajouter", configure: "Configurer", listLabel: "Éléments", edit: "Modifier", remove: "Supprimer", removeSure: "Confirmer la suppression", on: "actif", off: "inactif",
    onTip: "Visible pour Floppy", offTip: "Invisible pour Floppy : gardé dans la liste", active: "en service", cloud: "cloud",
    stepType: "Quel type ?", stepConfig: "Configuration", stepTry: "Vérifier avant d'enregistrer", tryBtn: "Essayer", trying: "Essai en cours…", tryNone: "Pas de test pour ce type.",
    required: "obligatoire", saved: "enregistré", pick: "Parcourir…", advanced: "Avancé", listHint: "un par ligne", addRow: "+ Ajouter une ligne",
    key: "clé", value: "valeur", noKinds: "Rien à ajouter ici.", noItems: "Rien pour l'instant.", noMatch: "Aucun résultat.", waiting: "En attente du noyau…",
    done: "C'est fait.", refused: "Refusé.", undone: "Annulé.", demoNote: "(démonstration) ",
    engines: "Moteurs disponibles", enginesNote: "fournis par les plugins installés", mode: "Mode",
    modeNeed: "Aucun moteur disponible : ajoute-en un ou rends-en un disponible.",
    activate: "Activer", activateAs: "Activer comme", remove1: "Retirer", removePlugin: "Retirer", removePluginSure: "Retirer ?", removePluginTip: "Retire ce plugin de Floppy. Rien n'est effacé : il revient par « + Ajouter un plugin ».", inUse: "En service", loading: "chargement…",
    idle: "en veille", failed: "en panne", noneChosen: "aucun",
    available: "Disponible", availTip: "Floppy le voit et peut l'utiliser", hiddenTip: "Masqué : Floppy ne le voit plus (rien n'est supprimé)",
    hidden: "masqué", makeAvail: "Rends-le disponible pour pouvoir l'activer.", provIdle: "En veille : rien ne s'en sert dans ce mode.",
    inUseShort: "en service", turnOffTip: "Éteindre : plus rien dans ce rôle", inUseTip: "En service. Pour changer, allume un autre élément.", activateTip: "Mettre en service (l'élément actuel s'arrête)", noMore: "Rien d'autre à régler ici.", openDetail: "ouvrir le détail", settingsTab: "Réglages", back: "Retour", crumbs: "Chemin", settingsBtn: "Réglages", onShort: "Actif", builtin: "intégré", addPlugin: "Ajouter un plugin",
    pluginsNote: "ils apportent les éléments ci-dessus", pluginsOf: "Plugins", needsSetup: "à configurer",
    stepModel: "Modèle", stepModelNote: "un seul chargé à la fois", stepItems: "Choix", stepItemsNote: "ceux du modèle choisi",
    loadedShort: "chargé", idleShort: "en veille", seeItems: "Voir",
    modeOff: "Ce mode n'est pas en service. « Activer » un moteur ci-dessous y passe Floppy.",
    modeOffLocal: "Floppy est en mode Live. « Activer » un élément ici le repasse dans ce mode.",
    categories: "Catégories", all: "Tous", source: "Source", builtinMany: "Intégrés", marketSoon: "Marketplace · bientôt",
    installed: "Installé", installedOff: "Installé · éteint", create: "Créer", createOwn: "Créer le tien", forRole: "Pour", forRoleTip: "Seuls les plugins compatibles sont montrés. Clique pour voir tout le catalogue.", noneCompatible: "Aucun plugin compatible pour l'instant.",
    hideIt: "Masquer", showIt: "Rendre disponible", settingsOf: "Réglages", engineOf: "Moteur", engineNote: "écoute, réfléchit et parle ; un seul à la fois",
    plugState: { active: "actif", error: "erreur", waiting: "en attente", loaded: "chargé", stopped: "arrêté", starting: "démarrage" },
    waitsFor: "attend", askVoice: "accord à la voix", cliOnly: "clic seulement", apply: "Appliquer", provError: "Erreur", childrenDef: "Éléments",
    statusOk: "ok", noPlugins: "Aucun plugin.", results: "Résultats", search0: "Recherche",
    getModels: "Télécharger des modèles", libTitle: "Modèles à télécharger", libFor: "Pour", dlRunning: "en cours",
    libKnown: "Choisis par Floppy", libKnownNote: "testés avec Floppy", libResults: "Résultats de la recherche", libSearching: "Recherche…",
    libNoResult: "Aucun modèle trouvé.", libSearchLabel: "Chercher un modèle", libConfirm: "Confirmer ?",
    libNote: "Télécharger un modèle, c'est accepter sa licence. Les fichiers vont dans le dossier des modèles (rubrique Général). Le téléchargement continue si tu fermes cette fenêtre.",
    libReady: "Prêt : active-le dans la liste.",
    savedOk: "Enregistré", saving: "Enregistrement…", listAddHint: "Ajouter, puis Entrée", removeWord: "Retirer", steps: "Étapes", tryNow: "Vérifier que ça marche",
  },
  en: {
    firstSetup: "Run the first setup again",
    onbTitle: "First setup", onbRunning: "running", onbDone: "finished", onbFailed: "a part failed",
    onbOf: "ready out of", onbDownloading: "downloading…", onbReady: "Ready", onbWaiting: "Waiting", onbFailedRow: "Failed",
    onbRoles: { vad: "Speech detector", stt: "Transcription", tts: "Voice", llm: "Brain", program: "Program" }, title: "Settings", search: "Search a setting, a plugin, a tool…", searchLabel: "Search a setting",
    undo: "Undo last change", assistant: "AI assistant", navLabel: "Sections",
    navNote: "Each section is built from the installed plugins. A new plugin adds its options here.",
    add: "Add", addIn: "Add", addTitle: "Add", editTitle: "Edit", cancel: "Cancel", close: "Close", save: "Save",
    addAndGo: "Add", configure: "Configure", listLabel: "Items", edit: "Edit", remove: "Delete", removeSure: "Confirm deletion", on: "on", off: "off",
    onTip: "Visible to Floppy", offTip: "Invisible to Floppy: kept in the list", active: "in use", cloud: "cloud",
    stepType: "Which type?", stepConfig: "Configuration", stepTry: "Check before saving", tryBtn: "Try", trying: "Trying…", tryNone: "No test for this type.",
    required: "required", saved: "saved", pick: "Browse…", advanced: "Advanced", listHint: "one per line", addRow: "+ Add a row",
    key: "key", value: "value", noKinds: "Nothing to add here.", noItems: "Nothing yet.", noMatch: "No result.", waiting: "Waiting for the kernel…",
    done: "Done.", refused: "Refused.", undone: "Undone.", demoNote: "(demo) ",
    engines: "Available engines", enginesNote: "provided by installed plugins", mode: "Mode",
    modeNeed: "No engine available: add one or make one available.",
    activate: "Activate", activateAs: "Activate as", remove1: "Remove", removePlugin: "Remove", removePluginSure: "Remove?", removePluginTip: "Removes this plugin from Floppy. Nothing is deleted: add it back with “+ Add a plugin”.", inUse: "In use", loading: "loading…",
    idle: "idle", failed: "failed", noneChosen: "none",
    available: "Available", availTip: "Floppy sees it and can use it", hiddenTip: "Hidden: Floppy no longer sees it (nothing is deleted)",
    hidden: "hidden", makeAvail: "Make it available to activate it.", provIdle: "Idle: nothing uses it in this mode.",
    inUseShort: "in use", turnOffTip: "Turn off: nothing in this role", inUseTip: "In use. To change, turn on another item.", activateTip: "Put in use (the current one stops)", noMore: "Nothing else to set here.", openDetail: "open details", settingsTab: "Settings", back: "Back", crumbs: "Path", settingsBtn: "Settings", onShort: "On", builtin: "built-in", addPlugin: "Add a plugin",
    pluginsNote: "they provide the items above", pluginsOf: "Plugins", needsSetup: "needs setup",
    stepModel: "Model", stepModelNote: "one loaded at a time", stepItems: "Choice", stepItemsNote: "those of the chosen model",
    loadedShort: "loaded", idleShort: "idle", seeItems: "See",
    modeOff: "This mode is not in use. “Activate” an engine below to switch Floppy to it.",
    modeOffLocal: "Floppy is in Live mode. “Activate” an item here to switch back to this mode.",
    categories: "Categories", all: "All", source: "Source", builtinMany: "Built-in", marketSoon: "Marketplace · soon",
    installed: "Installed", installedOff: "Installed · off", create: "Create", createOwn: "Create your own", forRole: "For", forRoleTip: "Only compatible plugins are shown. Click to see the whole catalogue.", noneCompatible: "No compatible plugin yet.",
    hideIt: "Hide", showIt: "Make available", settingsOf: "Settings", engineOf: "Engine:", engineNote: "listens, thinks and speaks; one at a time",
    plugState: { active: "active", error: "error", waiting: "waiting", loaded: "loaded", stopped: "stopped", starting: "starting" },
    waitsFor: "waiting for", askVoice: "voice approval", cliOnly: "click only", apply: "Apply", provError: "Error", childrenDef: "Items",
    statusOk: "ok", noPlugins: "No plugin.", results: "Results", search0: "Search",
    getModels: "Download models", libTitle: "Models to download", libFor: "For", dlRunning: "in progress",
    libKnown: "Picked by Floppy", libKnownNote: "tested with Floppy", libResults: "Search results", libSearching: "Searching…",
    libNoResult: "No model found.", libSearchLabel: "Search a model", libConfirm: "Confirm?",
    libNote: "Downloading a model means accepting its licence. Files go to the models folder (General section). The download goes on if you close this window.",
    libReady: "Ready: turn it on in the list.",
    savedOk: "Saved", saving: "Saving…", listAddHint: "Add, then Enter", removeWord: "Remove", steps: "Steps", tryNow: "Check that it works",
  },
};
let lang = "fr";
const t = (k) => I[lang]?.[k] ?? I.fr[k] ?? k;
/** Texte du noyau : chaîne simple, ou { fr, en }. */
const tr = (x) => {
  if (x === undefined || x === null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object") return x[lang] ?? x.fr ?? Object.values(x).find((v) => typeof v === "string") ?? "";
  return String(x);
};

// ------------------------------------------------------------------ rubriques (fournies par le noyau et les plugins)
// Payload : [{ id, label, description?, order, icon?, parent?, merge?, view? }]. Un id inconnu tombe dans « plugins ».
const FALLBACK = "plugins";
let sections = [];
const sectionById = (id) => sections.find((x) => x.id === id);
/** Rubrique de la page : une sous-rubrique (parent connu) s'affiche dans la page de son parent ; un id inconnu va dans « plugins ». */
const pageOf = (id) => {
  let sec = sectionById(id);
  if (!sec) return FALLBACK;
  for (let i = 0; sec.parent && sectionById(sec.parent) && i < 8; i++) sec = sectionById(sec.parent);
  return sec.id;
};
const secLabel = (id) => tr(sectionById(id)?.label) || id;
const pageOfProvider = pageOf;
const pageOfSetting = pageOf;

// ------------------------------------------------------------------ slots (choix d'éléments, faits par le noyau)
// Un slot (ex. « Cerveau principal », « Voix ») choisit un élément offert par un plugin. Le noyau fait tourner l'élément
// choisi seulement quand quelqu'un s'en sert. La fenêtre ne connaît aucun slot : tout vient de settings.slots.
const slotsOn = (page) => (settings.slots ?? []).filter((x) => pageOf(x.section) === page);
const slotSetting = (slot) => settings.list.find((x) => x.key === `slot.${slot.id}`);
/** Slots qu'un fournisseur d'éléments peut remplir. */
const slotsFor = (p) => (settings.slots ?? []).filter((x) => offersOf(p).includes(x.service));
const valueOf = (p, it) => `${p.source}/${it.id}`;
/** L'élément est-il proposé pour ce slot (disponible et offert maintenant) ? */
const canFill = (slot, p, it) => (slotSetting(slot)?.options ?? []).some((o) => o.value === valueOf(p, it));
const slotLabelOf = (slot) => {
  if (slot.value === "@none") return tr(slot.none) || t("noneChosen");
  const o = (slotSetting(slot)?.options ?? []).find((x) => x.value === slot.value);
  return o ? tr(o.label) : slot.value;
};
const slotStateText = (slot) => slot.state === "starting" ? t("loading") : slot.state === "idle" ? t("idle")
  : slot.state === "error" ? `${t("failed")} : ${tr(slot.error)}` : "";
/** Un slot de ce fournisseur sert-il en ce moment (actif, en démarrage, ou en panne visible) ? */
const provBusy = (p) => slotsFor(p).some((x) => ["active", "starting", "error"].includes(x.state));
let pendingSlot = "";   // slot en cours de changement (le chargement d'un modèle prend du temps)

async function setSlot(slot, value) {
  pendingSlot = slot.id;
  render();
  try { await setValue(`slot.${slot.id}`, value); } finally { pendingSlot = ""; render(); }
}

// ------------------------------------------------------------------ petits outils DOM
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) e.append(c);
  return e;
}
let uid = 0;
const nextId = () => `f${++uid}`;

let toastTimer = 0;
function toast(text, bad) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), bad ? 6000 : 3500);
}

// ------------------------------------------------------------------ état
let settings = { list: [], plugins: [] };
let items = { providers: [] };
let libraries = [];        // fournisseurs « library » (modèles à télécharger), montrés dans leur fenêtre
let libShape = "";         // forme des bibliothèques (voir libraryShape) : inchangée = mise à jour des barres seulement
let itemsKey = "";         // les autres fournisseurs, tels quels : inchangés = pas de rendu de la page
let section = location.hash.slice(1);   // vide : la première rubrique du menu
let query = "";
let deferred = false;      // un rendu attend que le champ en cours d'édition soit quitté
let removing = "";         // « fournisseur/id » en attente de confirmation de suppression
const open = new Set();    // sous-éléments dépliés

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const matches = (...texts) => !query || texts.some((x) => norm(tr(x)).includes(norm(query)));

// ------------------------------------------------------------------ appels au noyau
async function setValue(key, value) {
  if (!api) {
    const s = settings.list.find((x) => x.key === key);
    if (s) s.value = value;
    const slot = (settings.slots ?? []).find((x) => `slot.${x.id}` === key);
    if (slot) { slot.value = String(value); slot.state = value === "@none" ? "none" : "active"; }
    if (key === "langue_interface") setLang(String(value));
    render();
    toast(`${t("demoNote")}${key} = ${value}`);
    return;
  }
  try {
    const r = await api.set(key, value);
    toast(r?.text || (r?.ok ? t("done") : t("refused")), !r?.ok);
  } catch (e) { toast(String(e?.message ?? e), true); }
}

async function itemOp(op) {
  if (!api) { toast(`${t("demoNote")}${op.op} ${op.provider}`); return { ok: true, text: `${t("demoNote")}${op.op}` }; }
  try { return (await api.itemOp(op)) ?? { ok: false, text: t("refused") }; }
  catch (e) { return { ok: false, text: String(e?.message ?? e) }; }
}

async function quickOp(op) {
  const r = await itemOp(op);
  toast(r.text || (r.ok ? t("done") : t("refused")), !r.ok);
  return r;
}

// ------------------------------------------------------------------ contrôles des réglages
function labelOf(info) { return tr(info.label); }

function enumControl(info, apply) {
  const opts = info.options ?? [];
  if (opts.length > 4) {
    const sel = h("select", { "aria-label": labelOf(info), onchange: () => apply(sel.value) });
    for (const o of opts) sel.append(h("option", { value: o.value, text: tr(o.label) }));
    sel.value = String(info.value);
    return sel;
  }
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": labelOf(info) });
  for (const o of opts) {
    seg.append(h("button", { type: "button", role: "radio", "aria-checked": String(String(o.value) === String(info.value)), text: tr(o.label), onclick: () => apply(o.value) }));
  }
  return seg;
}

function boolControl(info, apply) {
  const on = info.value === true;
  return h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(on), "aria-label": labelOf(info), onclick: () => apply(!on) }, h("i"));
}

function numControl(info, apply) {
  const min = info.min ?? 0, max = info.max ?? 100;
  const r = h("input", { type: "range", "aria-label": labelOf(info), min, max, step: max - min <= 5 ? "0.1" : "1" });
  r.value = String(info.value);
  const out = h("output", { text: r.value });
  const show = () => { out.textContent = r.value; r.style.setProperty("--fill", `${((+r.value - min) / (max - min || 1)) * 100}%`); };
  r.addEventListener("input", show);
  r.addEventListener("change", () => apply(Number(r.value)));
  show();
  return h("div", { class: "num" }, r, out);
}

function textControl(info, apply) {
  const input = h("input", { type: "text", "aria-label": labelOf(info), maxlength: info.maxLength });
  input.value = String(info.value ?? "");
  const ok = h("button", { type: "button", text: t("apply"), onclick: () => apply(input.value) });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(input.value); });
  const box = h("div", {}, h("div", { class: "txt" }, input, ok));
  if (info.presets?.length) {
    const row = h("div", { class: "chips" });
    for (const p of info.presets) {
      row.append(h("button", { type: "button", class: String(p.value) === String(info.value) ? "on" : "", title: String(p.value), text: tr(p.label), onclick: () => { input.value = p.value; apply(p.value); } }));
    }
    box.append(row);
  }
  return box;
}

function settingRow(info) {
  const apply = (v) => setValue(info.key, v);
  const ctl = { enum: enumControl, boolean: boolControl, number: numControl, text: textControl }[info.type]?.(info, apply);
  const wide = info.type === "text";
  const label = h("div", { class: "label", text: labelOf(info) });
  if (info.risk === "ask") label.append(h("span", { class: "tag", text: t("askVoice") }));
  if (info.risk === "cli") label.append(h("span", { class: "tag cli", text: t("cliOnly") }));
  const head = h("div", {}, label, h("div", { class: "desc", text: tr(info.description) }));
  return h("div", { class: wide ? "row wide" : "row" }, head, ctl);
}

function settingsBlocks(list) {
  const groups = new Map();
  for (const s of list) {
    const g = tr(s.group) || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  return [...groups].map(([g, l]) => h("div", { class: "sgroup", "data-tab": g || t("settingsTab"), ...(isLight(l) ? { "data-light": "1" } : {}) }, g ? h("h3", { text: g }) : null, h("div", { class: "card" }, l.map(settingRow))));
}

// ------------------------------------------------------------------ éléments (fournisseurs)
const statusClass = (s) => (s === "ok" || s === "warn" || s === "error" || s === "loading" ? s : "");

// ------------------------------------------------------------------ liste + détail
// Une liste compacte (point d'état, nom, état court, type, interrupteur) et, à droite, le détail de l'élément choisi :
// description, boutons, réglages, outils, puis Modifier / Supprimer. Une seule chose importante par ligne.

function typeOf(it, typeTag) {
  // null : pas de type (ex. un corps : ses étiquettes sont des capacités, pas un type).
  if (typeTag === null) return "";
  return typeTag || tr((it.tags ?? [])[0]) || "";
}

function switchBtn(p, it, offering) {
  const canToggle = p.can.enable && it.toggleable !== false;
  const on = offering ? t("available") : t("on");
  return h("button", {
    type: "button", class: "sw", role: "switch", "aria-checked": String(!!it.enabled), disabled: !canToggle,
    title: it.enabled ? (offering ? t("availTip") : t("onTip")) : (offering ? t("hiddenTip") : t("offTip")),
    "aria-label": `${tr(it.label)} : ${it.enabled ? on : (offering ? t("hidden") : t("off"))}`,
    onclick: (e) => { e.stopPropagation(); quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }); },
  }, h("i"));
}

/** Slots dont cet élément est le choix. */
const filledBy = (p, it) => slotsFor(p).filter((x) => x.value === valueOf(p, it));

function shortStatus(p, it) {
  if (!it.enabled) return offersOf(p).length ? t("hidden") : t("off");
  const fills = filledBy(p, it);
  if (fills.length) {
    const st = fills.map(slotStateText).find(Boolean);
    return `${fills.map((x) => tr(x.label)).join(" · ")}${st ? ` · ${st}` : ""}`;
  }
  return tr(it.statusText) || (it.active ? t("active") : "");
}

// ------------------------------------------------------------------ liste en lignes + pages de détail
// Une ligne par élément : nom, une ligne de détails, état, [interrupteur], [action], [Réglages].
// « Réglages » ouvre la PAGE de l'élément (navigation, fil d'Ariane, Retour ou Échap) : suite de la description, actions,
// réglages propres, sous-éléments à cocher, rubrique rattachée (ex. la Veille sous sa tâche), puis Modifier / Masquer /
// Supprimer. Les éléments de cette page ouvrent à leur tour leur page : Tâches › Veille du jour › IA locale.
let detailStack = [];   // pages ouvertes : [{ pid, iid }], de la rubrique vers l'élément le plus profond

/**
 * Onglets génériques : les blocs qui portent un nom (data-tab) deviennent des onglets, un seul visible à la fois ;
 * les blocs sans nom restent au-dessus (tête, modes, messages), ceux marqués data-place="end" en dessous (Modifier,
 * Supprimer). Un seul nom : pas d'onglets, tout reste affiché. key : garde l'onglet choisi par page.
 */
const tabSel = new Map();
function tabify(key, nodes) {
  const list = nodes.filter(Boolean);
  // Un bloc léger (1 ou 2 réglages, ex. le Ton sous Voix) ne vaut pas un onglet : il reste affiché sur la page.
  const named = list.filter((n) => n.dataset?.tab && !n.dataset.light);
  const labels = [...new Set(named.map((n) => n.dataset.tab))];
  if (labels.length < 2) return list;
  let cur = tabSel.get(key);
  if (!labels.includes(cur)) cur = labels[0];
  const pick = (l) => { tabSel.set(key, l); navAnim = "tab"; render(); requestAnimationFrame(() => document.querySelector(".ptab.on")?.focus()); };
  // Un onglet « étape » (slot d'une chaîne, data-step) devient une case : n° et rôle, puis ce qui est en service.
  // Les étapes d'abord, dans leur ordre, reliées par des flèches ; les autres onglets (ex. Plugins) après.
  const stepOf = (l) => named.find((n) => n.dataset.tab === l && n.dataset.step);
  const steps = labels.filter(stepOf).sort((a, b) => Number(stepOf(a).dataset.step) - Number(stepOf(b).dataset.step));
  if (steps.length) labels.splice(0, labels.length, ...steps, ...labels.filter((l) => !stepOf(l)));
  const ids = labels.map(() => nextId());
  const tabBtn = (l, i) => {
    const node = stepOf(l);
    const kids = node ? [h("span", { class: "k", text: `${node.dataset.step} · ${l}` }), h("span", { class: "v", text: node.dataset.stepValue ?? "" })] : [l];
    return h("button", {
      type: "button", role: "tab", id: ids[i], class: `ptab${node ? " pstep" : ""}${l === cur ? " on" : ""}`, "aria-selected": String(l === cur), tabindex: l === cur ? "0" : "-1",
      onclick: () => pick(l),
      onkeydown: (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) { e.preventDefault(); pick(labels[(i + d + labels.length) % labels.length]); }
      },
    }, ...kids);
  };
  const bar = h("div", { class: `ptabs${steps.length ? " chain" : ""}`, role: "tablist", ...(steps.length ? { "aria-label": t("steps") } : {}) },
    labels.flatMap((l, i) => [
      i > 0 && i < steps.length ? h("span", { class: "parrow", "aria-hidden": "true" }, window.lucideIcon("arrow-right")) : null,
      steps.length && i === steps.length ? h("span", { class: "pgap", "aria-hidden": "true" }) : null,
      tabBtn(l, i),
    ].filter(Boolean)));
  const panel = h("div", { class: "tabpanel", role: "tabpanel", "aria-labelledby": ids[labels.indexOf(cur)] }, ...named.filter((n) => n.dataset.tab === cur));
  const top = list.filter((n) => !n.dataset?.tab && n.dataset?.place !== "end");
  const light = list.filter((n) => n.dataset?.tab && n.dataset.light);
  const end = list.filter((n) => n.dataset?.place === "end");
  return [...top, bar, panel, ...light, ...end];
}

/** Transition au prochain rendu : "fwd" (on avance), "back" (on revient), "fade" (autre rubrique), "tab" (autre onglet). */
let navAnim = "";

/** Ouvre la page d'un élément (par-dessus la page courante). */
function openDetail(p, it) {
  detailStack.push({ pid: p.id, iid: it.id });
  navAnim = "fwd";
  render();
  $("content").scrollTop = 0;
}
/** Remonte d'un cran (n = 1) ou jusqu'à la rubrique (n = Infinity). */
function closeDetail(n = 1) {
  detailStack = detailStack.slice(0, Math.max(0, detailStack.length - n));
  navAnim = "back";
  render();
  $("content").scrollTop = 0;
}

function rowList(listKey, entries) {
  const card = h("div", { class: "scard" });
  const groups = new Set(entries.map((e) => e[2] || "")).size > 1;
  let last = null;
  for (const [p, it, group] of entries) {
    if (groups && group !== last) { card.append(h("div", { class: "sgrp", text: group || "" })); last = group; }
    card.append(entryRow(listKey, p, it));
  }
  return card;
}

function entryRow(listKey, p, it) {
  const offering = offersOf(p).length > 0;
  const fills = filledBy(p, it);
  // Un seul rôle possible : son interrupteur est dans la ligne. Plusieurs (ex. cerveau ET délégation) : dans Réglages.
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  const one = roles.length === 1 ? roles[0] : null;
  const [first, ...more] = String(tr(it.detail) ?? "").split("\n");
  const err = it.status === "error" || fills.some((x) => x.state === "error");
  const cls = err ? "err" : it.status === "warn" ? "warn" : "";
  // Élément sans rôle (connecteur, centre d'intérêt, tâche) : interrupteur Actif, et sa 1re action en bouton.
  const plain = !offering && p.can.enable && it.toggleable !== false;
  const firstAct = !offering && it.enabled ? (it.actions ?? [])[0] : undefined;
  const el = row({
    name: tr(it.label), detail: first, state: shortStatus(p, it), stateCls: cls, cloud: it.cloud,
    here: one ? one.value === valueOf(p, it) : fills.length > 0,
    ...(one && it.enabled ? { canAct: canFill(one, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => setSlot(one, valueOf(p, it)), onOff: one.none ? () => setSlot(one, "@none") : null } : {}),
    ...(plain ? { actEl: switchBtn(p, it) } : {}),
    ...(firstAct ? { extraBtn: h("button", { type: "button", class: "btn small", text: tr(firstAct.label), onclick: (e) => { e.stopPropagation(); quickOp({ op: "action", provider: p.id, id: it.id, action: firstAct.id }); } }) } : {}),
    onSettings: () => openDetail(p, it), rowLink: true,
  });
  return h("div", { class: `rwrap${it.enabled ? "" : " off"}` }, el);
}

/** La page d'un élément : fil d'Ariane, titre, état et commandes, puis tout son détail. */
function detailPage() {
  // Retrouver chaque élément ; s'il a disparu (supprimé, plugin retiré), on s'arrête au dernier qui existe.
  const chain = [];
  for (const d of detailStack) {
    const p = items.providers.find((x) => x.id === d.pid);
    const it = p?.items.find((x) => x.id === d.iid);
    if (!p || !it) break;
    chain.push([p, it]);
  }
  if (chain.length !== detailStack.length) detailStack = detailStack.slice(0, chain.length);
  if (!chain.length) return null;
  const [p, it] = chain[chain.length - 1];
  const crumbs = h("nav", { class: "crumbs", "aria-label": t("crumbs") },
    h("button", { type: "button", class: "btn small back", onclick: () => closeDetail(1) }, window.lucideIcon("arrow-left"), t("back")),
    h("button", { type: "button", class: "crumb", text: secLabel(section), onclick: () => closeDetail(Infinity) }),
    ...chain.slice(0, -1).flatMap(([, x], i) => [h("span", { class: "sep", "aria-hidden": "true" }, window.lucideIcon("chevron-right")), h("button", { type: "button", class: "crumb", text: tr(x.label), onclick: () => closeDetail(chain.length - 1 - i) })]),
    h("span", { class: "sep", "aria-hidden": "true" }, window.lucideIcon("chevron-right")), h("span", { class: "crumb cur", "aria-current": "page", text: tr(it.label) }));
  const offering = offersOf(p).length > 0;
  const fills = filledBy(p, it);
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  const one = roles.length === 1 ? roles[0] : null;
  const [first, ...more] = String(tr(it.detail) ?? "").split("\n");
  const firstAct = !offering && it.enabled ? (it.actions ?? [])[0] : undefined;
  // La même ligne que dans la liste, sans « Réglages » : l'élément tel qu'on l'a quitté, avec ses commandes.
  const head = row({
    name: tr(it.label), detail: first, state: shortStatus(p, it), stateCls: it.status === "error" || fills.some((x) => x.state === "error") ? "err" : it.status === "warn" ? "warn" : "", cloud: it.cloud,
    here: one ? one.value === valueOf(p, it) : fills.length > 0,
    ...(one && it.enabled ? { canAct: canFill(one, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => setSlot(one, valueOf(p, it)), onOff: one.none ? () => setSlot(one, "@none") : null } : {}),
    ...(!offering && p.can.enable && it.toggleable !== false ? { actEl: switchBtn(p, it) } : {}),
    ...(firstAct ? { extraBtn: h("button", { type: "button", class: "btn small", text: tr(firstAct.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: firstAct.id }) }) } : {}),
  });
  return h("div", { class: "dpage" }, crumbs,
    h("div", { class: "page-head" }, h("div", {}, h("h2", { text: tr(it.label) }), h("p", { text: tr(p.label) }))),
    h("div", { class: "scard dhead" }, head),
    h("div", { class: "dbody" }, ...tabify(`detail:${detailStack.map((d) => `${d.pid}/${d.iid}`).join(">")}`, rowBody(p, it, more, !!firstAct))));
}

/** Le détail d'un élément, en blocs : sans nom (en haut), avec un nom d'onglet (data-tab), ou en bas (data-place="end"). */
function rowBody(p, it, more, firstShown) {
  const box = [];
  box.append = (...n) => box.push(...n);
  const offering = offersOf(p).length > 0;
  const roles = slotsFor(p).filter((x) => canFill(x, p, it) || x.value === valueOf(p, it));
  if (offering && roles.length > 1) box.append(activateBar(p, it));
  if (more.length) box.append(h("p", { class: "ddesc", text: more.join("\n") }));
  const form = inlineForm(p, it);
  if (form) box.append(form);
  const acts = (it.actions ?? []).slice(firstShown ? 1 : 0);
  if (acts.length && it.enabled) box.append(h("div", { class: "dacts" }, acts.map((a) => h("button", { type: "button", class: "btn small", text: tr(a.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: a.id }) }))));
  const own = (it.settings ?? []).map((key) => settings.list.find((x) => x.key === key)).filter(Boolean);
  if (own.length) box.append(h("div", { class: "card", "data-tab": t("settingsTab") }, own.map(settingRow)));
  if (it.children?.length) {
    const on = it.children.filter((c) => c.enabled).length;
    const ul = h("ul", { class: "dtools" });
    for (const c of it.children) {
      const id = nextId();
      const cb = h("input", { type: "checkbox", id, checked: c.enabled, disabled: !p.can.child });
      cb.addEventListener("change", () => quickOp({ op: "child", provider: p.id, id: it.id, child: c.id, on: cb.checked }));
      ul.append(h("li", {}, cb, h("label", { for: id }, h("code", { text: tr(c.label) }), c.detail ? h("small", { text: tr(c.detail) }) : null),
        c.tag ? h("span", { class: `chip ${c.tone === "warn" || c.tone === "danger" ? "warn" : "tag"}`, text: tr(c.tag) }) : null));
    }
    const lab = tr(it.childrenLabel ?? p.childrenLabel) || t("childrenDef");
    box.append(h("div", { class: "dsec", "data-tab": lab }, h("h4", { text: `${lab} · ${on}/${it.children.length}` }), ul));
  }
  // Rubrique rattachée (ex. la Veille sous « Veille du jour ») : son contenu ici, sans ses cartes de plugins.
  if (it.section) {
    const sub = [];
    pageNodes(it.section, sub, { embedded: true });
    box.append(...sub.filter(Boolean));
  }
  const foot = h("div", { class: "dfoot", "data-place": "end" });
  // Masquer un élément à rôle (modèle, voix) : il reste dans la liste, Floppy ne le voit plus.
  if (offering && p.can.enable && it.toggleable !== false) foot.append(h("button", { type: "button", class: "btn small", text: it.enabled ? t("hideIt") : t("showIt"), onclick: () => quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }) }));
  if (p.can.remove && it.removable !== false) {
    const k = `${p.id}/${it.id}`;
    const sure = removing === k;
    foot.append(h("button", {
      type: "button", class: "btn small danger", text: sure ? t("removeSure") : t("remove"),
      onclick: async () => {
        if (!sure) { removing = k; render(); setTimeout(() => { if (removing === k) { removing = ""; render(); } }, 5000); return; }
        removing = "";
        await quickOp({ op: "remove", provider: p.id, id: it.id });
      },
    }));
  }
  if (foot.childElementCount) box.append(foot);
  if (!box.length) box.append(h("p", { class: "ddesc", text: t("noMore") }));
  return box;
}

/** Boutons « Activer » d'un élément : un par slot qu'il peut remplir (ou l'état « En service » et « Retirer »). */
function activateBar(p, it) {
  const bar = h("div", { class: "dacts activate" });
  const slots = slotsFor(p);
  if (!it.enabled) { bar.append(h("p", { class: "desc", text: t("makeAvail") })); return bar; }
  for (const slot of slots) {
    const here = slot.value === valueOf(p, it);
    const busy = pendingSlot === slot.id;
    if (here) {
      const st = slotStateText(slot);
      bar.append(h("span", { class: `chip use${slot.state === "error" ? " err" : ""}` }, window.lucideIcon("check"), `${tr(slot.label)}${st ? ` · ${st}` : ""}`));
      if (slot.none) bar.append(h("button", { type: "button", class: "btn", disabled: busy, text: t("remove1"), onclick: () => setSlot(slot, "@none") }));
    } else if (canFill(slot, p, it)) {
      const text = busy ? t("loading") : slots.length > 1 ? `${t("activateAs")} ${tr(slot.label).toLowerCase()}` : t("activate");
      bar.append(h("button", { type: "button", class: "btn pri", disabled: busy || !!pendingSlot, text, title: tr(slot.description), onclick: () => setSlot(slot, valueOf(p, it)) }));
    }
  }
  return bar;
}

function visibleItems(p) {
  return p.items.filter((it) => matches(it.label, it.detail, ...(it.tags ?? []), it.id, ...(it.children ?? []).map((c) => c.label), p.label));
}

function providerCard(p) {
  const list = visibleItems(p);
  if (query && !list.length) return null;
  // Un fournisseur dont aucun slot ne sert en ce moment (ex. modèles locaux en mode Live) : grisé, avec la raison.
  const sleeping = slotsFor(p).length > 0 && !provBusy(p) && slotsFor(p).every((x) => x.state === "idle" || x.state === "none");
  const card = h("section", { class: `prov${sleeping ? " sleeping" : ""}`, "aria-label": tr(p.label), "data-tab": tr(p.label) });
  // Le bouton du haut de la page ajoute un plugin quand la rubrique a des plugins : l'ajout d'un élément va alors dans sa carte.
  const ownAdd = p.can.add && p.kinds.length && appProviders().some((a) => a.section === pageOfProvider(p.section));
  card.append(h("div", { class: "prov-head" }, h("strong", { text: tr(p.label) }), p.badge ? h("span", { class: "badge", text: tr(p.badge) }) : null,
    h("span", { class: "idetail desc", text: tr(p.description) }),
    ownAdd ? h("button", { type: "button", class: "btn small pri padd", text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) }) : null));
  if (p.error) card.append(h("div", { class: "ierr", role: "alert", text: `${t("provError")} : ${tr(p.error)}` }));
  if (sleeping && slotsFor(p).some((x) => x.state === "idle")) card.append(h("div", { class: "sleep-note", text: t("provIdle") }));
  if (!list.length) card.append(h("div", { class: "empty-line", text: t("noItems") }));
  else card.append(rowList(`prov:${p.id}`, list.map((it) => [p, it, ""])));
  return card;
}

function avatarGrid(p) {
  const list = visibleItems(p);
  if (query && !list.length) return null;
  const grid = h("div", { class: "avgrid", role: "list" });
  for (const it of list) {
    const name = tr(it.label);
    const tags = h("div", { class: "tags" });
    for (const g of it.tags ?? []) tags.append(h("span", { class: "chip tag", text: tr(g) }));
    const canToggle = p.can.enable && it.toggleable !== false;
    const foot = h("div", { class: "ctl" },
      ...(it.actions ?? []).map((a) => h("button", { type: "button", class: "btn small", text: tr(a.label), onclick: () => quickOp({ op: "action", provider: p.id, id: it.id, action: a.id }) })),
      h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(!!it.enabled), disabled: !canToggle, title: it.enabled ? t("onTip") : t("offTip"),
        "aria-label": `${name} : ${it.enabled ? t("on") : t("off")}`, onclick: () => quickOp({ op: "enable", provider: p.id, id: it.id, on: !it.enabled }) }, h("i"), h("span", { text: it.enabled ? t("on") : t("off") })));
    grid.append(h("div", { class: `av${it.active ? " on" : ""}${it.enabled ? "" : " off"}`, role: "listitem" },
      // Aperçu de l'avatar (image fixe) ; sans aperçu, son initiale.
      typeof it.preview === "string" && it.preview.startsWith("data:image/")
        ? h("div", { class: "pv img", "aria-hidden": "true" }, h("img", { src: it.preview, alt: "" }))
        : h("div", { class: "pv", "aria-hidden": "true", text: name.slice(0, 1).toUpperCase() }),
      h("div", { class: "bd", },
        h("div", { class: "t" }, h("strong", { text: name }), it.active ? h("span", { class: "chip", text: it.statusText ? tr(it.statusText) : t("active") }) : null),
        h("span", { class: "d", text: tr(it.detail) }), tags, foot)));
  }
  return grid;
}

// ------------------------------------------------------------------ bouton « Ajouter » d'une rubrique
function kindsOf(page) {
  const out = [];
  for (const p of items.providers) if (pageOfProvider(p.section) === page && p.can.add) for (const k of p.kinds) out.push({ provider: p, kind: k });
  return out;
}

function addButton(page) {
  const kinds = kindsOf(page);
  if (!kinds.length) return null;
  const only = [...new Set(kinds.map((k) => k.provider.id))];
  const label = only.length === 1 && items.providers.find((p) => p.id === only[0])?.addLabel ? tr(items.providers.find((p) => p.id === only[0]).addLabel) : `+ ${t("add")}`;
  const hasApps = appProviders().some((p) => p.section === page);
  return h("button", { type: "button", class: "btn pri", text: hasApps ? `+ ${t("addPlugin")}` : label, onclick: () => (hasApps ? openCatalogue(page) : openEditor({ mode: "add", kinds })) });
}

// ------------------------------------------------------------------ pages à slots (Cerveau, Voix, Écoute…)
// Même grammaire partout : « Activer » met un élément en service, le badge « en service » le montre, « Réglages » ouvre
// ses réglages, l'interrupteur « Actif » est seulement sur un plugin. Tout vient des déclarations : slots du noyau,
// fournisseurs d'éléments (offers) et applications (plugins qu'on ajoute, allume, éteint ou retire).
const uiTab = new Map();     // slot ou page -> onglet affiché
const uiGroup = new Map();   // slot -> groupe affiché (ex. modèle de voix)

const appProviders = () => items.providers.filter((p) => p.id.startsWith("apps-"));
/** L'application (plugin installé) d'une entrée : [fournisseur « apps-… », élément]. */
function appOf(source) {
  for (const p of appProviders()) { const it = p.items.find((x) => x.id === source); if (it) return [p, it]; }
  return null;
}
/** Plugins qui offrent un service : [entrée, ses fournisseurs d'éléments]. */
function pluginsFor(service) {
  const m = new Map();
  for (const p of items.providers) if (offersOf(p).includes(service)) { if (!m.has(p.source)) m.set(p.source, []); m.get(p.source).push(p); }
  return [...m];
}
const pluginName = (source, provs) => tr(appOf(source)?.[1].label) || tr(provs[0]?.label) || source;
/**
 * Choix d'un slot qu'aucune fiche du catalogue ne montre (ex. « Claude Sonnet » pour le tri : offert par le plugin Claude,
 * dont la fiche montre le cerveau). Tirés des options du réglage du slot, groupés par entrée : [entrée, options].
 */
function looseOptions(slot) {
  return sourcesOf(slot).filter((x) => x.options.length).map((x) => [x.source, x.options]);
}
/** Tous les plugins d'un slot (fournisseurs, plugins installés même éteints, choix offerts par ctx.offer seul). */
const sourcesOf = (slot) => slotSources(items.providers, slotSetting(slot)?.options ?? [], slot.service);
const modeSlotOf = (page) => slotsOn(page).find((x) => x.display === "mode");

function inUseBadge() { return h("span", { class: "inuse" }, h("i", { "aria-hidden": "true" }), t("inUseShort")); }

/** Ouvre les réglages d'un élément : sa page, avec son formulaire en place (la fenêtre ne sert plus qu'à ajouter). */
function openItemSettings(p, it) {
  if (dlg.open) dlg.close();
  openDetail(p, it);
}

/** Active un élément ; dans l'onglet d'un mode qui n'est pas en service, passe aussi dans ce mode. */
async function activate(slot, value, page) {
  await setSlot(slot, value);
  const mode = modeSlotOf(page);
  if (mode && mode !== slot && uiTab.get(mode.id) === "@none" && mode.value !== "@none") await setSlot(mode, "@none");
}

/**
 * Une ligne : nom, détail, état, [interrupteur], [action], [Réglages].
 * L'interrupteur remplace l'ancien bouton « Activer » : allumé = en service pour ce rôle ; en allumer un autre éteint
 * le précédent (un seul à la fois). L'éteindre : seulement si le rôle accepte « aucun » (onOff). actEl : un autre
 * interrupteur à la même place (Actif / Inactif d'un élément sans rôle).
 */
function row({ name, detail, state, stateCls, cloud, here, canAct, onAct, onOff, actEl, onSettings, settingsOpen, rowLink, lead, extraBtn, selected, onPick }) {
  // rowLink : toute la ligne ouvre la page de l'élément (flèche « › » au lieu du bouton Réglages).
  if (rowLink && onSettings) onPick = onSettings;
  const acts = h("div", { class: "racts" });
  if (actEl) acts.append(actEl);
  else if (onAct || here) {
    const can = here ? !!onOff : !!canAct;
    acts.append(h("button", {
      // En service sans « aucun » possible : allumé (pas grisé), le clic ne fait rien, la bulle dit comment changer.
      type: "button", class: "sw", role: "switch", "aria-checked": String(!!here), disabled: (!here && !can) || !!pendingSlot,
      "aria-disabled": here && !can ? "true" : null,
      "aria-label": `${name} : ${here ? t("inUseShort") : t("activate")}`,
      title: here ? (onOff ? t("turnOffTip") : t("inUseTip")) : t("activateTip"),
      onclick: (e) => { e.stopPropagation(); if (here) { if (onOff) onOff(); } else onAct?.(); },
    }, h("i")));
  } else acts.append(h("span", { class: "act" }));
  if (extraBtn) acts.append(extraBtn);
  if (onSettings && rowLink) acts.append(h("span", { class: "chev", "aria-hidden": "true" }, window.lucideIcon("chevron-right")));
  else if (onSettings) acts.append(h("button", { type: "button", class: `btn small${settingsOpen ? " on" : ""}`, "aria-expanded": settingsOpen === undefined ? null : String(settingsOpen), text: t("settingsBtn"), onclick: (e) => { e.stopPropagation(); onSettings(); } }));
  else if (!extraBtn) acts.append(h("span", { class: "setph" }));
  const st = here && !state ? t("inUseShort") : state;
  const el = h("div", { class: `srow${here ? " here" : ""}${selected ? " picked" : ""}${onPick ? " pick" : ""}` },
    lead ?? null,
    h("div", { class: "rt" }, h("div", { class: "rn" }, h("strong", { text: name }), cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null), detail ? h("div", { class: "rd", text: detail }) : null),
    h("span", { class: `rs ${stateCls || (here ? "use" : "")}`, text: st ?? "" }),
    acts);
  if (onPick) {
    el.tabIndex = 0;
    if (rowLink) el.setAttribute("aria-label", `${name} : ${t("openDetail")}`);
    el.addEventListener("click", onPick);
    // Entrée ou espace sur la ligne elle-même (pas sur un de ses boutons).
    el.addEventListener("keydown", (e) => { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(); } });
  }
  return el;
}

function itemRow(slot, p, it, page) {
  const v = valueOf(p, it);
  const here = slot.value === v;
  const st = here ? (slotStateText(slot) || tr(it.statusText)) : !it.enabled ? t("hidden") : tr(it.statusText);
  const cls = here && slot.state === "error" ? "err" : it.status === "warn" ? "warn" : it.status === "error" ? "err" : "";
  const editable = (p.can.update && it.editable !== false) || (p.can.enable && it.toggleable !== false) || (p.can.remove && it.removable !== false);
  return row({
    name: tr(it.label), detail: tr(it.detail), state: pendingSlot === slot.id && !here ? "" : st, stateCls: cls, cloud: it.cloud, here,
    canAct: canFill(slot, p, it) && it.status !== "warn" && it.status !== "error", onAct: () => activate(slot, v, page),
    onOff: slot.none ? () => activate(slot, "@none", page) : null,
    onSettings: editable ? () => openDetail(p, it) : null, rowLink: true,
  });
}

function optionRow(slot, o, page) {
  const here = slot.value === o.value;
  return row({
    name: tr(o.label), state: here ? slotStateText(slot) : "", stateCls: here && slot.state === "error" ? "err" : "", cloud: o.cloud, here,
    canAct: true, onAct: () => activate(slot, o.value, page),
    onOff: slot.none ? () => activate(slot, "@none", page) : null,
  });
}

function noneRow(slot, page) {
  return row({ name: tr(slot.none), here: slot.value === "@none", canAct: true, onAct: () => activate(slot, "@none", page) });
}

function secHead(title, sub, extra) {
  return h("h3", { class: "shead" }, h("span", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, extra ?? null);
}

/** Un slot en liste, groupée par plugin (ex. cerveau principal, délégation). */
function slotList(slot, page, { withNone = true, title, sub } = {}) {
  const card = h("div", { class: "scard" });
  const plugins = pluginsFor(slot.service).map(([source, provs]) => [source, provs, provs.flatMap((p) => p.items.map((it) => [p, it]))]).filter(([, , rows]) => rows.length);
  // Titre de groupe seulement s'il apporte quelque chose : un plugin qui a un seul élément porte déjà son nom.
  const headers = plugins.some(([, , rows]) => rows.length > 1);
  const loose = looseOptions(slot);
  const groups = plugins.length + loose.length;
  for (const [source, provs, rows] of plugins) {
    if (headers || (groups > 1 && loose.length && rows.length > 1)) card.append(h("div", { class: "sgrp", text: pluginName(source, provs) }));
    for (const [p, it] of rows) card.append(itemRow(slot, p, it, page));
  }
  for (const [source, opts] of loose) {
    if (groups > 1 && opts.length > 1) card.append(h("div", { class: "sgrp", text: pluginName(source, []) }));
    for (const o of opts) card.append(optionRow(slot, o, page));
  }
  if (withNone && slot.none) card.append(noneRow(slot, page));
  if (!card.childElementCount) card.append(h("div", { class: "empty-line", text: t("noItems") }));
  return h("section", { class: "ssec", "data-tab": title ?? tr(slot.label), ...stepAttrs(slot) }, secHead(title ?? tr(slot.label), sub ?? tr(slot.description)), card, slotAddBar(slot, page));
}

/**
 * Sous la liste d'un slot : « + Ajouter … » de chaque plugin installé qui peut ajouter un élément pour ce rôle
 * (ex. un modèle local), et « + Ajouter un plugin » (le catalogue : Codex, Antigravity, une API…).
 */
function slotAddBar(slot, page) {
  const bar = h("div", { class: "saddbar" });
  for (const [, provs] of pluginsFor(slot.service)) {
    for (const p of provs) if (p.can.add && p.kinds.length) bar.append(h("button", { type: "button", class: "btn small", text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) }));
  }
  const libs = librariesFor(libraries, slot.service);
  if (libs.length) bar.append(libButton(slot.service, "", tr(slot.label)));
  bar.append(h("button", { type: "button", class: "btn small", text: `+ ${t("addPlugin")}`, onclick: () => openCatalogue(page, roleOf(slot)) }));
  return bar;
}

/** Bandeau d'un plugin : description, « + Ajouter … », Réglages, interrupteur Actif. */
function pluginHead(source, provs, service, roleLabel, page) {
  const app = appOf(source);
  const text = tr(app?.[1].detail) || tr(provs[0]?.description);
  const btns = [];
  for (const p of provs) if (p.can.add && p.kinds.length) btns.push(h("button", { type: "button", class: "btn small", text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) }));
  if (service && librariesFor(libraries, service, source).length) btns.push(libButton(service, source, roleLabel));
  // Retirer / Actif sont dans l'onglet Plugins quand la page en a un : ici, seulement pour rallumer un plugin éteint.
  if (app && (!app[1].enabled || !hasPluginsTab(page))) { const c = pluginControls(app[0], app[1]); btns.push(...c.acts, ...c.sw); }
  // Rien à faire : la description seule, sans carte.
  if (!btns.length) return text ? h("p", { class: "ddesc pdesc", text }) : null;
  return h("div", { class: "scard phead" }, h("p", { text }), ...btns);
}
/** La page a-t-elle un onglet Plugins (au moins un slot montré en liste) ? */
const hasPluginsTab = (page) => !!page && slotsOn(page).some((x) => x.display !== "tabs" && x.display !== "mode");

/**
 * Commandes d'un plugin (application) : « Réglages » seulement s'il a un formulaire, « Retirer » (2 clics : le 2e
 * confirme), et l'interrupteur « Actif ». Retirer ne supprime rien sur le disque : le plugin revient par « + Ajouter un plugin ».
 */
function pluginControls(ap, it) {
  const acts = [];
  if (it.editable) acts.push(h("button", { type: "button", class: "btn small", text: t("settingsBtn"), onclick: () => openItemSettings(ap, it) }));
  if (ap.can.remove && it.removable !== false) {
    const k = `${ap.id}/${it.id}`;
    const sure = removing === k;
    acts.push(h("button", {
      type: "button", class: `btn small${sure ? " danger" : ""}`, text: sure ? t("removePluginSure") : t("removePlugin"), title: t("removePluginTip"),
      onclick: async () => {
        if (!sure) { removing = k; render(); setTimeout(() => { if (removing === k) { removing = ""; render(); } }, 5000); return; }
        removing = "";
        await quickOp({ op: "remove", provider: ap.id, id: it.id });
      },
    }));
  }
  const sw = [
    h("span", { class: "swl", text: t("onShort") }),
    h("button", { type: "button", class: "sw", role: "switch", "aria-checked": String(!!it.enabled), "aria-label": `${tr(it.label)} : ${t("onShort")}`, onclick: () => quickOp({ op: "enable", provider: ap.id, id: it.id, on: !it.enabled }) }, h("i")),
  ];
  return { acts, sw };
}

/** Les plugins qui apportent les éléments d'un ou plusieurs services, et « + Ajouter un plugin ». */
function pluginCards(services, page, title) {
  const seen = new Set();
  const grid = h("div", { class: "pgrid" });
  const extra = (s) => (settings.slots ?? []).filter((x) => x.service === s).flatMap((x) => looseOptions(x).map(([e]) => [e, []]));
  const own = appProviders().filter((ap) => ap.section === page).flatMap((ap) => ap.items.map((it) => [it.id, []]));
  for (const [source, provs] of [...own, ...services.flatMap((s) => [...pluginsFor(s), ...extra(s)])]) {
    if (seen.has(source)) continue;
    seen.add(source);
    const app = appOf(source);
    // Ligne 1 : nom, « intégré », interrupteur Actif. Ligne 2 : « + Ajouter … », Réglages.
    const top = h("div", { class: "pctop" }, h("strong", { text: pluginName(source, provs) }), h("span", { class: "chip", text: t("builtin") }));
    const acts = h("div", { class: "pcacts" });
    for (const p of provs) if (p.can.add && p.kinds.length) acts.append(h("button", { type: "button", class: "btn small", text: `+ ${tr(p.addLabel) || t("add")}`, onclick: () => openEditor({ mode: "add", kinds: p.kinds.map((k) => ({ provider: p, kind: k })) }) }));
    if (app) { const c = pluginControls(app[0], app[1]); top.append(...c.sw); acts.append(...c.acts); }
    grid.append(h("div", { class: "scard pcard" }, top, acts));
  }
  grid.append(h("button", { type: "button", class: "addcard", text: `+ ${t("addPlugin")}`, onclick: () => openCatalogue(page, { services: slotsOn(page).map((x) => x.service), label: secLabel(page) }) }));
  return h("section", { class: "ssec", "data-tab": title }, secHead(title, t("pluginsNote")), grid);
}

/** Un slot en onglets, un par plugin (ex. Voix, mot d'activation). */
function slotTabs(slot, page) {
  const plugins = sourcesOf(slot);
  const active = entryOf(slot.value);
  const ids = [...plugins.map((x) => x.source), ...(slot.none ? ["@none"] : [])];
  let cur = uiTab.get(slot.id);
  if (!ids.includes(cur)) cur = ids.includes(active) ? active : ids[0];
  const tabs = h("div", { class: "stabs", role: "tablist", "aria-label": tr(slot.label) });
  const tabBtn = (id, label, extra) => h("button", { type: "button", role: "tab", class: `stab${id === cur ? " on" : ""}`, "aria-selected": String(id === cur), onclick: () => { uiTab.set(slot.id, id); render(); } }, label, extra);
  for (const { source, provs } of plugins) {
    const app = appOf(source)?.[1];
    const bad = (it) => it.enabled && (it.status === "warn" || it.status === "error");
    const warn = provs.some((p) => p.items.some(bad)) || (app && bad(app));
    tabs.append(tabBtn(source, pluginName(source, provs), source === active ? inUseBadge() : warn ? h("span", { class: "wdot", "aria-label": t("needsSetup") }) : null));
  }
  if (slot.none) tabs.append(tabBtn("@none", tr(slot.none), active === "@none" ? inUseBadge() : null));
  tabs.append(h("button", { type: "button", class: "stab add", text: `+ ${t("addPlugin")}`, onclick: () => openCatalogue(page, roleOf(slot)) }));
  const panel = h("div", { class: "spanel" });
  if (cur === "@none") panel.append(h("div", { class: "scard" }, noneRow(slot, page)));
  else {
    const { provs = [], options = [] } = plugins.find((x) => x.source === cur) ?? {};
    const headNode = pluginHead(cur, provs, slot.service, tr(slot.label), page);
    if (headNode) panel.append(headNode);
    const rows = provs.flatMap((p) => p.items.map((it) => [p, it]));
    const single = rows.length === 1 && !options.length && !rows[0][1].group ? rows[0] : null;
    if (single) panel.append(...singleItem(slot, single[0], single[1], page));
    else if (rows.some(([, it]) => it.group)) panel.append(...groupedRows(slot, rows, page));
    else {
      const card = h("div", { class: "scard" });
      for (const [p, it] of rows) card.append(itemRow(slot, p, it, page));
      // Choix offerts par ctx.offer seul (ex. les voix du système) : rien d'autre ne les montre.
      for (const o of options) card.append(optionRow(slot, o, page));
      if (!card.childElementCount) {
        const app = appOf(cur)?.[1];
        // Plugin éteint, ou en erreur : dire pourquoi la liste est vide plutôt que « Rien pour l'instant ».
        card.append(h("div", { class: "empty-line", text: app && (!app.enabled || app.status === "error" || app.status === "warn") ? tr(app.statusText) : t("noItems") }));
      }
      panel.append(card);
    }
  }
  return h("section", { class: "ssec", "data-tab": tr(slot.label), ...stepAttrs(slot) }, secHead(tr(slot.label), tr(slot.description)), tabs, panel);
}

/**
 * L'unique élément d'un onglet de plugin (ex. les mots d'activation) : pas de ligne qui répète l'onglet. En service :
 * l'onglet le dit déjà. Sinon (ou en panne) : sa ligne, pour l'activer. Puis son formulaire en place, et sa ligne de
 * détail (ex. le dernier réveil).
 */
function singleItem(slot, p, it, page) {
  const here = slot.value === valueOf(p, it);
  const form = inlineForm(p, it);
  const out = [];
  if (!here || slot.state === "error" || !form) out.push(h("div", { class: "scard" }, itemRow(slot, p, it, page)));
  if (form) out.push(form);
  const detail = tr(it.detail);
  if (here && form && detail) out.push(h("p", { class: "ddesc idline", text: detail }));
  return out;
}

/** Deux étapes : 1. le groupe (ex. le modèle), 2. l'élément de ce groupe (ex. la voix). */
function groupedRows(slot, rows, page) {
  const groups = [];
  for (const [, it] of rows) if (it.group && !groups.some((g) => g.id === it.group.id)) groups.push(it.group);
  const here = rows.find(([p, it]) => slot.value === valueOf(p, it));
  const hereGroup = here?.[1].group?.id;
  let sel = uiGroup.get(slot.id);
  if (!groups.some((g) => g.id === sel)) sel = hereGroup ?? groups[0]?.id;
  const step = (n, title, sub, extra) => h("h3", { class: "shead" }, h("span", { class: "step", text: String(n) }), h("span", { text: title }), sub ? h("span", { class: "sub", text: sub }) : null, extra ?? null);
  const models = h("div", { class: "scard" });
  for (const g of groups) {
    const inG = rows.filter(([p, it]) => it.group?.id === g.id && canFill(slot, p, it));
    const isHere = g.id === hereGroup;
    models.append(row({
      name: tr(g.label), detail: tr(g.detail), here: isHere, selected: g.id === sel,
      state: isHere ? (slotStateText(slot) || t("loadedShort")) : t("idleShort"),
      canAct: inG.length > 0, onAct: () => { uiGroup.set(slot.id, g.id); return activate(slot, valueOf(...inG[0]), page); },
      extraBtn: h("button", { type: "button", class: "btn small", text: t("seeItems"), "aria-pressed": String(g.id === sel), onclick: (e) => { e.stopPropagation(); uiGroup.set(slot.id, g.id); render(); } }),
      onPick: () => { uiGroup.set(slot.id, g.id); render(); },
    }));
  }
  const g = groups.find((x) => x.id === sel);
  const voices = h("div", { class: "scard" });
  for (const [p, it] of rows.filter(([, it]) => it.group?.id === sel)) voices.append(itemRow(slot, p, it, page));
  return [
    h("section", { class: "ssec" }, step(1, t("stepModel"), t("stepModelNote")), models),
    h("section", { class: "ssec" }, step(2, `${t("stepItems")} · ${tr(g?.label)}`, t("stepItemsNote")), voices),
  ];
}

/** Page avec un slot « mode » : onglets de mode, puis le contenu de l'onglet choisi. */
function modeTabs(page, mode) {
  const live = mode.value !== "@none";
  let cur = uiTab.get(mode.id);
  if (cur !== "@none" && cur !== "some") cur = live ? "some" : "@none";
  uiTab.set(mode.id, cur === "some" ? "some" : "@none");
  const tab = (id, label, on) => h("button", { type: "button", role: "tab", class: `stab big${id === cur ? " on" : ""}`, "aria-selected": String(id === cur), onclick: () => { uiTab.set(mode.id, id); render(); } }, label, on ? inUseBadge() : null);
  return h("div", { class: "stabs modes", role: "tablist", "aria-label": t("mode") },
    tab("@none", tr(mode.none), !live), tab("some", tr(mode.label), live),
    h("span", { class: "tabnote", text: tr(mode.description) }));
}

/** Slots de la page en cours qui forment une chaîne (voir chainOf) : slot -> n° d'étape. */
let chainNow = new Map();
/** Onglet « étape » d'un slot de la chaîne : son n° et ce qui est en service. */
function stepAttrs(slot) {
  const n = chainNow.get(slot.id);
  return n ? { "data-step": String(n), "data-step-value": slotLabelOf(slot) } : {};
}

function slotPage(page, nodes, restSettings, embedded = false) {
  const mode = modeSlotOf(page);
  const chain = chainOf(slotsOn(page).filter((x) => x !== mode));
  chainNow = new Map((chain ?? []).map((x, i) => [x.id, i + 1]));
  const others = chain ?? slotsOn(page).filter((x) => x !== mode);
  // Fournisseurs de la page qui n'offrent rien (ni slot, ni application) : le contenu propre de la rubrique (ex. les
  // centres d'intérêt de la Veille). En premier : c'est ce qu'on vient régler.
  for (const p of items.providers) {
    if (pageOfProvider(p.section) !== page || offersOf(p).length || p.id.startsWith("apps-")) continue;
    const c = p.layout === "grid" ? avatarGrid(p) : providerCard(p);
    if (c) nodes.push(c);
  }
  const body = [];
  let listed = [];
  if (mode) {
    body.push(modeTabs(page, mode));
    if (uiTab.get(mode.id) === "some") {
      if (mode.value === "@none") body.push(h("div", { class: "sinfo", text: t("modeOff") }));
      body.push(slotList(mode, page, { withNone: false, title: `${t("engineOf")} ${tr(mode.label)}`, sub: t("engineNote") }));
      listed = [mode.service];
    } else {
      if (mode.value !== "@none") body.push(h("div", { class: "sinfo", text: t("modeOffLocal") }));
      for (const s of others) body.push(s.display === "tabs" ? slotTabs(s, page) : slotList(s, page));
      listed = others.filter((s) => s.display !== "tabs").map((s) => s.service);
    }
  } else {
    for (const s of others) body.push(s.display === "tabs" ? slotTabs(s, page) : slotList(s, page));
    listed = others.filter((s) => s.display !== "tabs").map((s) => s.service);
  }
  nodes.push(...body);
  if (restSettings.length) nodes.push(...settingsBlocks(restSettings));
  if (listed.length && !embedded) nodes.push(pluginCards(listed, page, t("pluginsOf")));
}

/** Ce qui est en service, pour le menu de gauche. */
function navSummary(page) {
  const mode = modeSlotOf(page);
  if (mode) {
    if (mode.value !== "@none") return `${tr(mode.label)} · ${slotLabelOf(mode)}`;
    const main = slotsOn(page).find((x) => x !== mode && !x.none) ?? slotsOn(page).find((x) => x !== mode);
    return main ? `${tr(mode.none)} · ${slotLabelOf(main)}` : tr(mode.none);
  }
  const s = slotsOn(page)[0];
  return s ? slotLabelOf(s) : "";
}

// ------------------------------------------------------------------ catalogue des plugins
let catalog = null;   // { category, source, role?: { services, label } }

/**
 * Ouvre le catalogue. Depuis un rôle (role = { services, label }, ex. le mot d'activation) : seulement les plugins
 * qui fournissent un de ces services ; la pastille « Pour : … » enlève le filtre. Sinon : la rubrique de la page.
 */
function openCatalogue(page, role) {
  ed = null; library = null;
  dlg.classList.remove("library");
  const cats = appProviders().map((p) => p.section);
  catalog = role?.services?.length ? { category: "", source: "builtin", role } : { category: cats.includes(page) ? page : "", source: "builtin" };
  drawCatalogue();
  if (!dlg.open) dlg.showModal();
}
const roleOf = (slot) => ({ services: [slot.service], label: tr(slot.label) });
/** Une fiche (type d'ajout) remplit-elle le rôle demandé ? */
const fitsRole = (services) => !catalog.role || (services ?? []).some((s) => catalog.role.services.includes(s));

function drawCatalogue() {
  if (!catalog) return;
  const apps = appProviders();
  const kindsOfApp = (p) => p.kinds.filter((k) => fitsRole(k.provides));
  const nav = h("nav", { class: "ccats", "aria-label": t("categories") });
  const catBtn = (id, label, n) => h("button", { type: "button", class: `ccat${catalog.category === id ? " on" : ""}`, "aria-pressed": String(catalog.category === id), onclick: () => { catalog.category = id; drawCatalogue(); } }, h("span", { text: label }), h("small", { text: String(n) }));
  nav.append(catBtn("", t("all"), apps.reduce((n, p) => n + kindsOfApp(p).length, 0)));
  for (const p of apps) if (kindsOfApp(p).length) nav.append(catBtn(p.section, secLabel(p.section), kindsOfApp(p).length));
  const list = h("div", { class: "clist" });
  list.append(h("div", { class: "csrc", role: "group", "aria-label": t("source") },
    h("button", { type: "button", class: "pill on", "aria-pressed": "true", text: t("builtinMany") }),
    h("button", { type: "button", class: "pill", disabled: true, text: t("marketSoon") }),
    catalog.role ? h("button", { type: "button", class: "pill on", title: t("forRoleTip"), "aria-label": `${t("forRole")} : ${catalog.role.label} — ${t("forRoleTip")}`, text: `${t("forRole")} : ${catalog.role.label} ×`, onclick: () => { catalog.role = undefined; drawCatalogue(); } }) : null));
  const grid = h("div", { class: "cgrid" });
  for (const p of apps.filter((x) => !catalog.category || x.section === catalog.category)) {
    for (const k of kindsOfApp(p)) {
      const installed = p.items.filter((it) => it.kind === k.id);
      const foot = h("div", { class: "cfoot" });
      if (installed.length) {
        const it = installed[0];
        foot.append(h("span", { class: it.enabled ? "done" : "off", text: it.enabled ? t("installed") : t("installedOff") }),
          h("button", { type: "button", class: "btn small", text: t("settingsBtn"), onclick: () => { catalog = null; openItemSettings(p, it); } }));
      } else {
        foot.append(h("span"), h("button", { type: "button", class: "btn small pri", text: t("add"), onclick: async () => {
          if (k.fields.length) { catalog = null; openEditor({ mode: "add", kinds: [{ provider: p, kind: k }] }); return; }
          const r = await quickOp({ op: "add", provider: p.id, kind: k.id, values: {} });
          if (r.ok) drawCatalogue();
        } }));
      }
      grid.append(h("div", { class: "ccard" },
        h("div", { class: "ct" }, h("strong", { text: tr(k.label) }), catalog.category ? null : h("span", { class: "chip", text: secLabel(p.section) })),
        h("p", { text: tr(k.description) }),
        h("div", { class: "tags" }, h("span", { class: "chip", text: t("builtin") }), k.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null),
        foot));
    }
  }
  if (!grid.childElementCount && catalog.role) list.append(h("div", { class: "empty-line", text: t("noneCompatible") }));
  else list.append(grid);
  // « Créer le tien » : les types d'éléments que les plugins installés savent créer (MCP local, modèle GGUF…).
  // Depuis un rôle : seulement les fournisseurs qui l'offrent (un modèle ONNX de transcription ne fait pas un mot d'activation).
  const own = items.providers.filter((p) => !p.id.startsWith("apps-") && p.can.add && p.kinds.length && fitsRole(offersOf(p)) && (!catalog.category || pageOfProvider(p.section) === catalog.category));
  if (own.length) {
    const mine = h("div", { class: "cgrid" });
    for (const p of own) for (const k of p.kinds) {
      mine.append(h("div", { class: "ccard mine" }, h("strong", { text: tr(k.label) }), h("p", { text: tr(k.description) }),
        h("div", { class: "tags" }, h("span", { class: "chip", text: tr(p.label) }), k.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null),
        h("div", { class: "cfoot" }, h("span"), h("button", { type: "button", class: "btn small", text: t("create"), onclick: () => { catalog = null; openEditor({ mode: "add", kinds: [{ provider: p, kind: k }] }); } }))));
    }
    list.append(h("h3", { class: "chd", text: t("createOwn") }), mine);
  }
  dlg.replaceChildren(
    h("div", { class: "ed-head chead" }, h("h2", { id: "editor-title", text: t("addPlugin") }),
      h("button", { type: "button", class: "btn small", "aria-label": t("close"), text: "×", onclick: () => { catalog = null; dlg.close(); } })),
    h("div", { class: "cbody" }, nav, list));
  dlg.classList.add("catalog");
}

// ------------------------------------------------------------------ bibliothèque de modèles (téléchargements)
// Une fenêtre par rôle (ex. Transcription) : les modèles choisis par Floppy, la recherche en ligne si le plugin la
// propose, une barre d'avancement par téléchargement. Les barres se mettent à jour sans redessiner (voir patchLibraries).
let library = null;   // { service, source, role, query, results: [[provider, item]] | null, searching, armed, list }

/** Texte du bouton : « Télécharger des modèles » ou « … · 1 en cours · 42 % ». */
function libSummary(service, source) {
  const { count, progress } = downloadSummary(librariesFor(libraries, service, source || undefined));
  if (!count) return "";
  return ` · ${count} ${t("dlRunning")}${progress === null ? "" : ` · ${percent(progress)} %`}`;
}

function libButton(service, source, role) {
  return h("button", { type: "button", class: "btn small lib", onclick: () => openLibrary(service, source, role) },
    window.lucideIcon("download"), h("span", { text: t("getModels") }),
    h("span", { class: "libsum", "data-libsum": "1", "data-service": service, "data-source": source ?? "", text: libSummary(service, source) }));
}

function openLibrary(service, source, role) {
  ed = null; catalog = null;
  library = { service, source, role, query: "", results: null, searching: false, armed: "", list: null };
  drawLibrary(true);
  if (!dlg.open) dlg.showModal();
}

const libsOpen = () => (library ? librariesFor(libraries, library.service, library.source || undefined) : []);

/** L'état à jour d'un élément : celui de la liste (avancement), sinon celui du résultat de recherche. */
function liveItem(providerId, id) {
  const p = libraries.find((x) => x.id === providerId);
  return p?.items.find((x) => x.id === id) ?? library?.results?.find(([pp, it]) => pp.id === providerId && it.id === id)?.[1];
}

async function libAction(p, it, action) {
  const r = await quickOp({ op: "action", provider: p.id, id: it.id, action });
  if (r.ok && action === "download" && library?.results) drawLibrary();
}

/** Barre d'avancement + texte (« 42 % · 1,2 / 2,9 Go »). */
function progressNode(it) {
  const pct = percent(it.progress);
  // Largeur par le CSSOM : la politique de sécurité de la fenêtre refuse l'attribut style.
  const fill = h("i");
  fill.style.width = `${pct}%`;
  return h("div", { class: "lprog" },
    h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": tr(it.label) }, fill),
    h("span", { class: "lst", text: tr(it.statusText) }));
}

function libRow(p, it) {
  const side = h("div", { class: "lside" });
  const acts = it.actions ?? [];
  // Un seul bouton plein par écran (DESIGN.md) : Télécharger reste secondaire, avec son icône.
  const btn = (a, icon) => h("button", { type: "button", class: `btn small${icon ? " lib" : ""}`, "aria-label": `${tr(a.label)} : ${tr(it.label)}`, onclick: () => libAction(p, it, a.id) },
    icon ? window.lucideIcon(icon) : null, h("span", { text: tr(a.label) }));
  if (it.status === "loading") {
    side.append(progressNode(it), ...acts.map((a) => btn(a)));
  } else {
    if (it.status === "ok") side.append(h("span", { class: "lst good" }, window.lucideIcon("check"), h("span", { text: tr(it.statusText) })));
    const main = acts.find((a) => a.id === "download" || a.id === "use");
    for (const a of acts.filter((x) => x !== main)) {
      if (a.id !== "remove") { side.append(btn(a)); continue; }
      // Supprimer : le 1er clic arme, le 2e confirme (5 s).
      const k = `${p.id}/${it.id}`;
      const sure = library?.armed === k;
      side.append(h("button", { type: "button", class: `btn small${sure ? " danger" : ""}`, text: sure ? t("libConfirm") : tr(a.label), "aria-label": `${sure ? t("libConfirm") : tr(a.label)} : ${tr(it.label)}`,
        onclick: () => {
          if (!sure) { library.armed = k; drawLibrary(); setTimeout(() => { if (library?.armed === k) { library.armed = ""; drawLibrary(); } }, 5000); return; }
          library.armed = "";
          void libAction(p, it, "remove");
        } }));
    }
    if (main) side.append(btn(main, main.id === "download" ? "download" : null));
  }
  const tags = (it.tags ?? []).map((x) => h("span", { class: "chip tag", text: tr(x) }));
  return h("div", { class: "srow lrow", "data-provider": p.id, "data-id": it.id },
    h("div", { class: "rt" },
      h("div", { class: "rn" }, h("strong", { text: tr(it.label) })),
      it.detail ? h("div", { class: "rd", text: tr(it.detail) }) : null,
      it.status === "error" ? h("div", { class: "lerr", role: "alert", text: tr(it.statusText) }) : null,
      tags.length ? h("div", { class: "tags" }, tags) : null),
    side);
}

let libTimer = 0;
async function runLibrarySearch() {
  if (!library) return;
  const q = library.query;
  const searchable = libsOpen().filter((p) => p.can.search);
  if (q.length < 2) { library.results = null; library.searching = false; drawLibrary(); return; }
  library.searching = true; drawLibrary();
  const found = [];
  for (const p of searchable) {
    const r = await itemOp({ op: "search", provider: p.id, query: q });
    if (!r.ok) toast(r.text || t("refused"), true);
    for (const it of r.items ?? []) found.push([p, it]);
  }
  if (!library || library.query !== q) return; // une autre recherche est partie
  library.results = found; library.searching = false;
  drawLibrary();
}

/** full : construit la fenêtre (titre, recherche, pied) ; sinon seulement la liste (le champ de recherche garde le focus). */
function drawLibrary(full = false) {
  if (!library) return;
  const libs = libsOpen();
  if (full || !library.list || !dlg.contains(library.list)) {
    library.list = h("div", { class: "lbody", "aria-live": "polite" });
    const searchable = libs.filter((p) => p.can.search);
    const search = searchable.length ? h("div", { class: "lsearch" }, h("input", {
      type: "search", class: "lsinput", "aria-label": t("libSearchLabel"), placeholder: tr(searchable[0].searchHint) || t("libSearchLabel"), value: library.query,
      oninput: (e) => { library.query = e.target.value.trim(); clearTimeout(libTimer); libTimer = setTimeout(runLibrarySearch, 400); },
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(libTimer); void runLibrarySearch(); } },
    })) : null;
    dlg.replaceChildren(
      h("div", { class: "ed-head chead" },
        h("h2", { id: "editor-title" }, h("span", { text: t("libTitle") }), library.role ? h("span", { class: "sub", text: ` · ${t("libFor")} ${library.role}` }) : null),
        h("button", { type: "button", class: "btn small", "aria-label": t("close"), text: "×", onclick: () => dlg.close() })),
      search, library.list,
      h("p", { class: "lfoot", text: t("libNote") }));
    dlg.classList.add("catalog", "library");
    // Le focus va à la recherche (sinon le navigateur le pose sur « Fermer »).
    if (search) queueMicrotask(() => search.querySelector("input")?.focus());
  }
  const nodes = [];
  if (library.query.length >= 2 && libs.some((p) => p.can.search)) {
    nodes.push(h("h3", { class: "shead" }, h("span", { text: t("libResults") })));
    const card = h("div", { class: "scard" });
    if (!library.results?.length) card.append(h("div", { class: "empty-line", text: library.searching ? t("libSearching") : t("libNoResult") }));
    else for (const [p, it] of library.results) card.append(libRow(p, liveItem(p.id, it.id) ?? it));
    nodes.push(card);
  }
  for (const p of libs) {
    if (!p.items.length) continue;
    nodes.push(h("h3", { class: "shead" }, h("span", { text: libs.length > 1 ? tr(p.label) : t("libKnown") }), h("span", { class: "sub", text: tr(p.description) || t("libKnownNote") })));
    const card = h("div", { class: "scard" });
    for (const it of p.items) card.append(libRow(p, it));
    nodes.push(card);
  }
  if (!nodes.length) nodes.push(h("div", { class: "empty-line", text: t("noItems") }));
  library.list.replaceChildren(...nodes);
}

/** Pendant un téléchargement : seulement les barres, les textes d'état et les résumés des boutons. */
function patchLibraries() {
  for (const el of document.querySelectorAll("[data-libsum]")) el.textContent = libSummary(el.dataset.service, el.dataset.source);
  if (!library?.list) return;
  for (const row of library.list.querySelectorAll(".lrow[data-id]")) {
    const it = liveItem(row.dataset.provider, row.dataset.id);
    const bar = row.querySelector(".pbar");
    if (!it || !bar) continue;
    const pct = percent(it.progress);
    bar.setAttribute("aria-valuenow", String(pct));
    bar.firstElementChild.style.width = `${pct}%`;
    row.querySelector(".lprog .lst").textContent = tr(it.statusText);
  }
}

// ------------------------------------------------------------------ pages
// ------------------------------------------------------------------ installation de départ (suivie depuis la rubrique Général)
let onb = null;   // dernier état de l'installation de départ (onboarding.state du noyau)

/** Avancement de l'installation de départ : un morceau par ligne (programme, écoute, voix, cerveau), et ce qui s'est activé. */
function onboardingBlock() {
  const sum = installSummary(onb);
  if (!sum) return null;
  const words = { downloading: t("onbDownloading"), ready: t("onbReady"), waiting: t("onbWaiting"), failed: t("onbFailedRow") };
  const state = sum.running ? t("onbRunning") : sum.failed ? t("onbFailed") : t("onbDone");
  const card = h("div", { class: "card" }, onb.rows.map((r) => {
    const pct = Math.floor((r.progress ?? (r.state === "ready" ? 1 : 0)) * 100);
    // Largeur par le CSSOM : la politique de sécurité de la fenêtre refuse l'attribut style.
    const fill = h("i");
    fill.style.width = `${pct}%`;
    const st = rowStatus(r, (k) => words[k] ?? k, lang);
    return h("div", { class: "irow" },
      h("div", { class: "grow" }, h("div", { class: "name", text: tr(r.label) }), h("div", { class: "desc", text: t("onbRoles")[r.role] ?? r.role })),
      h("div", { class: "lprog" },
        h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": tr(r.label) }, fill),
        h("span", { class: r.state === "ready" ? "lst good" : "lst", text: st })));
  }));
  if (onb.notes?.length) card.append(h("ul", { class: "onb-notes" }, onb.notes.map((n) => h("li", { text: tr(n) }))));
  return h("div", { class: "block" }, h("h3", {}, t("onbTitle"), h("small", { text: `${state} · ${sum.ready} ${t("onbOf")} ${sum.total}` })), card);
}

function updateOnboarding(s) {
  onb = s ?? null;
  if (section === "general" && !query && !detailStack.length) render();
}

function pageHead(page, extra) {
  return h("div", { class: "page-head" }, h("div", {}, h("h2", { text: secLabel(page) }), h("p", { text: tr(sectionById(page)?.description) })), extra);
}

function pluginsBlock() {
  const rows = settings.plugins.filter((p) => matches(p.id, p.plugin, ...(p.provides ?? []), tr(p.error)));
  const card = h("div", { class: "card" });
  if (!rows.length) card.append(h("div", { class: "empty", text: t("noPlugins") }));
  for (const p of rows) {
    const cls = p.state === "active" ? "ok" : p.state === "error" ? "error" : "";
    const stateLabel = t("plugState")?.[p.state] ?? p.state;
    const st = h("span", { class: `dot ${cls}`.trim(), title: stateLabel, role: "img", "aria-label": stateLabel });
    const name = h("div", {}, h("span", { class: "name", text: p.id }));
    const bits = [p.plugin !== p.id ? p.plugin : "", ...(p.provides ?? [])].filter(Boolean);
    if (bits.length) name.append(h("span", { class: "prov", text: bits.join(" · ") }));
    const row = h("div", { class: "plug" }, st, name);
    row.append(h("div", { class: "state", text: t("plugState")[p.state] ?? p.state }));
    const err = tr(p.error) || (p.missing?.length ? `${t("waitsFor")} ${p.missing.join(", ")}` : "");
    if (err) row.append(h("div", { class: "err", text: err }));
    card.append(row);
  }
  return h("div", { class: "sgroup", "data-tab": secLabel(FALLBACK) }, h("h3", { text: secLabel(FALLBACK) }), card);
}

function pageNodes(page, nodes, { embedded = false } = {}) {
  const sec = sectionById(page);
  const sets = settings.list.filter((s) => pageOfSetting(s.section) === page && matches(s.label, s.description, s.key, s.group, ...(s.options ?? []).map((o) => o.label)));
  const provs = items.providers.filter((p) => pageOfProvider(p.section) === page);
  const roles = slotsOn(page).length > 0;
  // Réglages rattachés à un élément (ex. Orca) : montrés dans l'élément (« Configurer »), pas dans la liste.
  // Les slots (slot.*) se règlent avec « Activer » sur les éléments, et l'interrupteur de mode.
  const owned = new Set(items.providers.flatMap((p) => p.items.flatMap((it) => it.settings ?? [])));
  const rest = sets.filter((s) => !s.key.startsWith("slot.") && !owned.has(s.key));

  if (roles && !query) {
    slotPage(page, nodes, rest, embedded);
    if (sec?.view === "plugins") nodes.push(pluginsBlock());
    return;
  }
  const provNodes = [];
  const gridNodes = [];
  // Rubrique « merge » (corps, connecteurs…) : UNE liste pour la rubrique, quel que soit le plugin qui fournit l'élément
  // (son nom devient une étiquette). Un plugin sans élément n'affiche rien : on l'ajoute avec le bouton « Ajouter ».
  const merged = !!sec?.merge;
  const lists = provs.filter((p) => p.layout !== "grid");
  if (merged) {
    const list = lists.flatMap((p) => visibleItems(p).map((it) => [p, it]));
    if (list.length || !query) {
      const card = h("section", { class: "prov", "aria-label": secLabel(page), "data-tab": secLabel(page) });
      // Pas de titre ici : la page a déjà son titre et sa description.
      if (!list.length) card.append(h("div", { class: "empty-line", text: t("noItems") }));
      // Le nom du plugin sert d'étiquette de type, sauf s'il n'y en a qu'un seul.
      else {
        const many = new Set(list.map(([pp]) => pp.id)).size > 1;
        card.append(rowList(`page:${page}`, list.map(([p, it]) => [p, it, many ? tr(p.label) : ""])));
      }
      provNodes.push(card);
    }
  }
  for (const p of provs) {
    if (p.layout === "grid") {
      const g = avatarGrid(p);
      if (g) gridNodes.push(h("div", { class: "block", "data-tab": tr(p.label) }, h("h3", {}, tr(p.label), p.description ? h("small", { text: tr(p.description) }) : null), g));
    } else if (!merged) { const c = providerCard(p); if (c) provNodes.push(c); }
  }
  const provBlock = () => {
    if (!provNodes.length && !(lists.length && !query)) return;
    const head = roles ? h("div", { class: "block" }, h("h3", {}, t("engines"), h("small", { text: t("enginesNote") }))) : null;
    nodes.push(head, ...provNodes);
  };
  const setBlock = () => {
    const own = rest.filter((s) => s.section === page);
    if (own.length) nodes.push(...settingsBlocks(own));
    // Sous-rubriques : un bloc par sous-rubrique, avec son titre.
    for (const sub of [...new Set(rest.map((s) => s.section))].filter((id) => id !== page)) {
      const subSets = rest.filter((s) => s.section === sub);
      nodes.push(h("div", { class: "block", "data-tab": secLabel(sub), ...(isLight(subSets) ? { "data-light": "1" } : {}) }, h("h3", { text: secLabel(sub) }), ...settingsBlocks(subSets)));
    }
  };
  if (merged || roles) { provBlock(); nodes.push(...gridNodes); setBlock(); }
  else { setBlock(); provBlock(); nodes.push(...gridNodes); }
  if (sec?.view === "plugins") nodes.push(pluginsBlock());
}

/** Rubriques du menu : sans parent, et avec du contenu (réglages, éléments) ou une vue spéciale. */
function navSections() {
  const filled = (id) => settings.list.some((s) => pageOf(s.section) === id) || items.providers.some((p) => pageOf(p.section) === id);
  // Une rubrique rattachée à un élément (ex. la Veille, réglée sous sa tâche) n'a pas d'entrée dans le menu.
  const attached = new Set(items.providers.flatMap((p) => p.items.map((it) => it.section).filter(Boolean)));
  return sections.filter((x) => !x.parent && !attached.has(x.id) && (x.view || filled(x.id)));
}

function render() {
  // On ne reconstruit pas pendant qu'on tape dans un champ : le rendu attend la fin de la saisie.
  const a = document.activeElement;
  if (a && $("content").contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox" && a.type !== "range") { deferred = true; return; }
  deferred = false;
  // Page demandée absente du menu (hash inconnu, plugin retiré) : la première rubrique.
  const nav = navSections();
  if (nav.length && !nav.some((x) => x.id === section)) section = nav[0].id;
  $("assistant-btn").hidden = !sections.some((x) => x.view === "assistant");
  renderNav();
  const root = $("content");
  const showAssistant = sectionById(section)?.view === "assistant" && !query;
  root.hidden = showAssistant;
  $("pane-assistant").hidden = !showAssistant;
  $("assistant-btn").setAttribute("aria-pressed", String(showAssistant));
  if (showAssistant) return;
  const top = root.scrollTop;
  const nodes = [];
  let detail = null;
  if (query) {
    nodes.push(h("div", { class: "page-head" }, h("div", {}, h("h2", { text: t("results") }), h("p", { text: `« ${query} »` }))));
    for (const sec of navSections()) {
      if (sec.view && sec.view !== "plugins") continue;
      const sub = [];
      pageNodes(sec.id, sub);
      if (sub.some(Boolean)) nodes.push(h("div", { class: "block" }, h("h3", { text: secLabel(sec.id) }), ...sub));
    }
    if (nodes.length === 1) nodes.push(h("div", { class: "empty", text: t("noMatch") }));
  } else if (detailStack.length && (detail = detailPage())) {
    nodes.push(detail);
  } else {
    // Rubrique Général : refaire le réglage de départ (fenêtre « Bienvenue »).
    const head = section === "general" && api?.openOnboarding
      ? h("button", { type: "button", class: "btn", text: t("firstSetup"), onclick: () => api.openOnboarding() })
      : slotsOn(section).length ? null : addButton(section);
    const page = [pageHead(section, head)];
    if (section === "general") page.push(onboardingBlock());
    pageNodes(section, page);
    nodes.push(...tabify(`page:${section}`, page));
    if (!settings.list.length && !items.providers.length) nodes.push(h("div", { class: "empty", text: api ? t("waiting") : "" }));
  }
  root.replaceChildren(...nodes.filter(Boolean));
  root.scrollTop = top;
  if (navAnim) {
    // Relance l'animation même si la classe était déjà là (retrait, reflow, ajout).
    root.classList.remove("anim-fwd", "anim-back", "anim-fade", "anim-tab");
    void root.offsetWidth;
    root.classList.add(`anim-${navAnim}`);
    navAnim = "";
  }
}

function renderNav() {
  const nav = $("nav");
  nav.setAttribute("aria-label", t("navLabel"));
  const count = (page) => items.providers.filter((p) => p.layout !== "grid" && pageOf(p.section) === page).reduce((n, p) => n + p.items.length, 0);
  nav.replaceChildren(...navSections().map((sec) => {
    const n = count(sec.id);
    const name = secLabel(sec.id);
    const sum = navSummary(sec.id);
    return h("button", { type: "button", class: "nav", "data-initial": name.slice(0, 1), ...(sec.icon ? { "data-icon": sec.icon } : {}), ...(sec.id === section && !query ? { "aria-current": "page" } : {}),
      onclick: () => { section = sec.id; detailStack = []; navAnim = "fade"; setQuery(""); } }, sum ? h("span", { class: "navt" }, h("span", { text: name }), h("small", { text: sum })) : name, !sum && n ? h("span", { class: "badge", text: String(n) }) : null);
  }), h("p", { class: "nav-note", text: t("navNote") }));
}

function setQuery(q) {
  query = q;
  if (q) detailStack = [];
  const input = $("search");
  if (input.value !== q) input.value = q;
  render();
}

function applyStaticTexts() {
  document.documentElement.lang = lang;
  document.title = `Floppy — ${t("title")}`;
  $("title").textContent = t("title");
  $("search").placeholder = t("search");
  $("search").setAttribute("aria-label", t("searchLabel"));
  $("undo").textContent = t("undo");
  $("assistant-btn").textContent = t("assistant");
}

function setLang(l) {
  if (!I[l] || l === lang) return;
  lang = l;
  applyStaticTexts();
}

// ------------------------------------------------------------------ éditeur (ajouter ; modifier se fait sur la page de l'élément)
const dlg = $("editor");
let ed = null;

function defaultsOf(kind) {
  const v = {};
  for (const f of kind.fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

function openEditor(init) {
  catalog = null; library = null;
  dlg.classList.remove("catalog", "library");
  ed = { kinds: init.kinds ?? [], provider: null, kind: null, values: {}, step: 1, result: null, trial: null, busy: false };
  if (ed.kinds.length === 1) chooseKind(ed.kinds[0]);
  drawEditor();
  if (!dlg.open) dlg.showModal();
}

function chooseKind(k) {
  ed.provider = k.provider;
  ed.kind = k.kind;
  ed.values = defaultsOf(k.kind);
  ed.trial = null;
  ed.step = 2;
}

function closeEditor() { if (dlg.open) dlg.close(); ed = null; }
dlg.addEventListener("close", () => { ed = null; catalog = null; library = null; dlg.classList.remove("catalog", "library"); if (deferred) render(); });
dlg.addEventListener("cancel", () => { ed = null; });

const visible = (f, values) => !f.showIf || (f.showIf.values ?? []).some((v) => String(v) === String(values[f.showIf.key]));

/**
 * Le contrôle d'un champ déclaré. values : les valeurs du formulaire (modifiées en place). Chaque changement « fini »
 * (champ quitté, Entrée, case cochée, pastille ajoutée ou retirée) émet un événement « change » qui remonte : le
 * formulaire en place l'enregistre.
 */
function fieldControl(f, values, onChange) {
  const id = nextId();
  const v = values[f.key];
  const set = (x) => { values[f.key] = x; onChange(); };
  let ctl;
  switch (f.type) {
    case "boolean": {
      ctl = h("input", { type: "checkbox", id, checked: v === true });
      ctl.addEventListener("change", () => set(ctl.checked));
      return { id, ctl, inline: true };
    }
    case "number": {
      ctl = h("input", { type: "number", id, min: f.min, max: f.max, step: "any" });
      ctl.value = v === undefined || v === null ? "" : String(v);
      ctl.addEventListener("input", () => set(ctl.value === "" ? undefined : Number(ctl.value)));
      break;
    }
    case "select": {
      ctl = h("select", { id });
      for (const o of f.options ?? []) ctl.append(h("option", { value: o.value, text: tr(o.label) }));
      if (v === undefined && f.options?.length) values[f.key] = f.options[0].value;
      ctl.value = String(values[f.key] ?? "");
      ctl.addEventListener("change", () => set(ctl.value));
      break;
    }
    case "secret": {
      const was = v === SECRET_SET;
      ctl = h("input", { type: "password", id, autocomplete: "new-password", placeholder: was ? t("saved") : tr(f.placeholder) });
      ctl.addEventListener("input", () => set(ctl.value || (was ? SECRET_SET : "")));
      break;
    }
    case "path": {
      const input = h("input", { type: "text", id, placeholder: tr(f.placeholder) });
      input.value = v ?? "";
      input.addEventListener("input", () => set(input.value));
      const pick = h("button", { type: "button", class: "btn small", text: t("pick"), disabled: !api?.pickPath, onclick: async () => {
        const p = await api.pickPath({ directory: !!f.directory, filters: f.filters ?? [] });
        if (p) { input.value = p; set(p); input.dispatchEvent(new Event("change", { bubbles: true })); }
      } });
      ctl = h("div", { class: "pathrow" }, input, pick);
      ctl.labelTarget = input;
      break;
    }
    case "list": {
      // Pastilles : × retire, Entrée (ou virgule) ajoute ; un collage de plusieurs lignes donne plusieurs pastilles.
      const input = h("input", { type: "text", id, placeholder: tr(f.placeholder) || t("listAddHint") });
      const box = h("div", { class: "lchips", role: "group", onclick: (e) => { if (e.target === box) input.focus(); } }, input);
      const now = () => (Array.isArray(values[f.key]) ? values[f.key] : []);
      const changed = () => box.dispatchEvent(new Event("change", { bubbles: true }));
      const draw = () => {
        for (const n of box.querySelectorAll(".lchip")) n.remove();
        for (const x of now()) box.insertBefore(h("span", { class: "lchip" }, h("span", { text: x }),
          h("button", { type: "button", "aria-label": `${t("removeWord")} ${x}`, onclick: () => { set(now().filter((y) => y !== x)); draw(); input.focus(); changed(); } }, "×")), input);
      };
      const take = (text) => {
        const next = listAdd(now(), text);
        input.value = "";
        if (next.length === now().length) return;
        set(next); draw(); changed();
      };
      input.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); take(input.value); } });
      input.addEventListener("paste", (e) => { const text = e.clipboardData?.getData("text") ?? ""; if (/[\n,;]/.test(text)) { e.preventDefault(); take(text); } });
      // Texte tapé puis champ quitté : il compte aussi (rien ne se perd). Son propre « change » ne remonte pas.
      input.addEventListener("change", (e) => { e.stopPropagation(); if (input.value.trim()) take(input.value); });
      draw();
      ctl = box;
      ctl.labelTarget = input;
      break;
    }
    case "textarea": {
      ctl = h("textarea", { id, placeholder: tr(f.placeholder) });
      ctl.value = v ?? "";
      ctl.addEventListener("input", () => set(ctl.value));
      break;
    }
    case "keyvalue": {
      const rows = Object.entries(v && typeof v === "object" ? v : {});
      const box = h("div", { class: "kv", id, role: "group" });
      const sync = () => {
        const o = {};
        for (const r of box.querySelectorAll(".r")) { const [k, val] = r.querySelectorAll("input"); if (k.value.trim()) o[k.value.trim()] = val.value; }
        set(o);
      };
      const addRow = (k = "", val = "") => {
        const ki = h("input", { type: "text", "aria-label": t("key"), placeholder: t("key") });
        const vi = h("input", { type: "text", "aria-label": t("value"), placeholder: t("value") });
        ki.value = k; vi.value = val;
        ki.addEventListener("input", sync); vi.addEventListener("input", sync);
        const del = h("button", { type: "button", class: "btn small", "aria-label": t("remove"), text: "×", onclick: () => { r.remove(); sync(); box.dispatchEvent(new Event("change", { bubbles: true })); } });
        const r = h("div", { class: "r" }, ki, vi, del);
        box.insertBefore(r, add);
      };
      const add = h("button", { type: "button", class: "btn small", text: t("addRow"), onclick: () => addRow() });
      box.append(add);
      for (const [k, val] of rows) addRow(k, String(val));
      ctl = box;
      break;
    }
    default: {
      ctl = h("input", { type: "text", id, placeholder: tr(f.placeholder) });
      ctl.value = v ?? "";
      ctl.addEventListener("input", () => set(ctl.value));
    }
  }
  return { id, ctl };
}

function formNode(kind, values) {
  const form = h("div", { class: "form" });
  const adv = h("div", { class: "form" });
  const wraps = [];
  const refresh = () => { for (const [f, w] of wraps) w.hidden = !visible(f, values); };
  for (const f of kind.fields) {
    const { id, ctl, inline } = fieldControl(f, values, refresh);
    const lab = h("label", { for: ctl.labelTarget ? ctl.labelTarget.id : id }, tr(f.label), f.required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null);
    if (f.required) (ctl.labelTarget ?? ctl).setAttribute("aria-required", "true");
    const hint = f.hint ? h("span", { class: "hint", text: tr(f.hint) }) : null;
    const wide = f.type === "textarea" || f.type === "list" || f.type === "keyvalue";
    const w = inline ? h("div", { class: "field check" }, ctl, lab, hint) : h("div", { class: wide ? "field wide" : "field" }, lab, ctl, hint);
    wraps.push([f, w]);
    (f.advanced ? adv : form).append(w);
  }
  refresh();
  if (adv.childElementCount) form.append(h("details", { class: "adv" }, h("summary", { text: t("advanced") }), adv));
  return form;
}

function missingFields() {
  return missingOf(ed.kind.fields, ed.values, visible);
}

async function runTrial() {
  const e = ed; // Échap pendant l'attente met `ed` à null : on garde notre propre référence.
  e.busy = true; e.trial = { running: true };
  drawEditor();
  const r = await itemOp({ op: "test", provider: e.provider.id, kind: e.kind.id, values: e.values });
  e.busy = false; e.trial = r;
  if (ed === e) drawEditor();
}

async function submit() {
  const miss = missingFields();
  if (miss.length) { ed.trial = { ok: false, text: `${t("required")} : ${miss.map((f) => tr(f.label)).join(", ")}` }; drawEditor(); return; }
  const e = ed; // Échap pendant l'attente met `ed` à null : on garde notre propre référence.
  e.busy = true; drawEditor();
  const r = await itemOp({ op: "add", provider: e.provider.id, kind: e.kind.id, values: e.values });
  e.busy = false;
  if (ed !== e) { if (r.ok) toast(r.text || t("done")); return; } // éditeur fermé entre-temps
  e.result = r;
  drawEditor();
}

function drawEditor() {
  if (!ed) return;
  const title = `${t("addTitle")}${ed.kind ? " : " + tr(ed.kind.label) : ""}`;
  const body = h("div", { class: "ed-body" });
  const foot = h("div", { class: "ed-foot" });
  const closeBtn = h("button", { type: "button", class: "btn", text: ed.result ? t("close") : t("cancel"), onclick: closeEditor });

  if (ed.result) {
    body.append(h("div", { class: ed.result.ok ? "result" : "result bad", role: "status" }, h("pre", { text: ed.result.text || (ed.result.ok ? t("done") : t("refused")) })));
    if (!ed.result.ok) foot.append(h("button", { type: "button", class: "btn", text: t("edit"), onclick: () => { ed.result = null; drawEditor(); } }));
    foot.append(closeBtn);
  } else if (ed.step === 1) {
    body.append(h("div", { class: "step-h" }, h("span", { class: "step", text: "1" }), t("stepType")));
    const types = h("div", { class: "types" });
    for (const k of ed.kinds) {
      types.append(h("button", { type: "button", class: "type", onclick: () => { chooseKind(k); drawEditor(); } },
        h("span", { class: "l" }, h("strong", { text: tr(k.kind.label) }), k.kind.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null, h("span", { class: "badge", text: tr(k.provider.label) })),
        k.kind.description ? h("small", { text: tr(k.kind.description) }) : null));
    }
    if (!ed.kinds.length) body.append(h("div", { class: "empty", text: t("noKinds") }));
    body.append(types);
    foot.append(closeBtn);
  } else {
    // Numéros d'étape : « 1. choisir le type » existe seulement s'il y a plusieurs types à ajouter.
    const n0 = ed.kinds.length > 1 ? 1 : 0;
    body.append(h("div", { class: "step-h" }, h("span", { class: "step", text: String(n0 + 1) }), tr(ed.kind.label), ed.kind.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null));
    if (ed.kind.description) body.append(h("div", { class: "desc", text: tr(ed.kind.description) }));
    const hasForm = ed.kind.fields.length > 0;
    if (hasForm) body.append(formNode(ed.kind, ed.values));
    if (ed.provider.can.test && hasForm) {
      const tb = h("div", { class: "try" },
        h("div", { class: "step-h" }, h("span", { class: "step", text: String(n0 + 2) }), t("stepTry"),
          h("button", { type: "button", class: "btn small", text: ed.trial?.running ? t("trying") : t("tryBtn"), disabled: ed.busy, onclick: runTrial })));
      if (ed.trial && !ed.trial.running) {
        tb.append(h("pre", { class: ed.trial.ok ? "" : "bad", role: "status", text: ed.trial.text ?? "" }));
        if (ed.trial.children?.length) {
          const ul = h("ul", { class: "plainlist" });
          for (const c of ed.trial.children) ul.append(h("li", { text: [tr(c.label), tr(c.detail)].filter(Boolean).join(" — ") }));
          tb.append(ul);
        }
      }
      body.append(tb);
    } else if (ed.trial && !ed.trial.running) body.append(h("pre", { class: "bad", role: "alert", text: ed.trial.text }));
    if (ed.kinds.length > 1) foot.append(h("button", { type: "button", class: "btn", "aria-label": t("stepType"), onclick: () => { ed.step = 1; ed.trial = null; drawEditor(); } }, window.lucideIcon("arrow-left")));
    foot.append(closeBtn);
    if (hasForm) foot.append(h("button", { type: "button", class: "btn pri", disabled: ed.busy, text: t("addAndGo"), onclick: submit }));
  }
  dlg.replaceChildren(h("div", { class: "ed-head" }, h("h2", { id: "editor-title", text: title })), body, foot);
}

// ------------------------------------------------------------------ formulaire en place (page d'un élément)
// Les champs du type de l'élément, directement sur sa page : chaque changement s'enregistre seul. La fenêtre
// (éditeur) ne sert plus qu'à AJOUTER un élément.
const drafts = new Map();   // « fournisseur/élément » -> valeurs refusées, gardées jusqu'au prochain enregistrement réussi
const saves = new Map();    // « fournisseur/élément » -> { ok, busy, text, at } : dernier enregistrement, montré sur le formulaire
const trials = new Map();   // « fournisseur/élément » -> résultat du dernier essai
let saveSeq = 0;

function inlineForm(p, it) {
  const kind = p.kinds.find((x) => x.id === it.kind);
  if (!p.can.update || it.editable === false || !kind?.fields.length) return null;
  const key = `${p.id}/${it.id}`;
  const values = drafts.get(key) ?? { ...defaultsOf(kind), ...(it.values ?? {}) };
  const last = saves.get(key);
  const fresh = last?.ok && Date.now() - last.at < 2500;
  const status = h("span", { class: `fsaved${fresh ? " ok" : ""}`, role: "status", text: last?.busy ? t("saving") : fresh ? `✓ ${t("savedOk")}` : "" });
  const err = h("p", { class: "ferr", role: "alert", hidden: !(last && !last.ok && !last.busy), text: last && !last.ok ? last.text : "" });
  const form = formNode(kind, values);
  // L'état est écrit dans la page tout de suite : le rendu complet attend que le champ en cours de saisie soit quitté.
  const show = (state) => {
    saves.set(key, state);
    status.textContent = state.busy ? t("saving") : state.ok ? `✓ ${t("savedOk")}` : "";
    status.classList.toggle("ok", !!state.ok);
    err.textContent = !state.ok && !state.busy ? state.text : "";
    err.hidden = !!state.ok || !!state.busy;
  };
  const save = async () => {
    const miss = missingOf(kind.fields, values, visible);
    if (miss.length) {
      drafts.set(key, values);
      show({ ok: false, text: `${t("required")} : ${miss.map((f) => tr(f.label)).join(", ")}`, at: Date.now() });
      return;
    }
    const n = ++saveSeq;
    show({ busy: true, at: Date.now() });
    const r = await itemOp({ op: "update", provider: p.id, id: it.id, values: { ...values } });
    if (n !== saveSeq) return; // un enregistrement plus récent est parti entre-temps
    if (r.ok) {
      drafts.delete(key);
      show({ ok: true, at: Date.now() });
      setTimeout(() => { if (saveSeq === n) status.textContent = ""; render(); }, 2600);
    } else {
      drafts.set(key, values);
      show({ ok: false, text: tr(r.text) || t("refused"), at: Date.now() });
    }
    render();
  };
  form.addEventListener("change", () => { void save(); });
  const box = h("div", { class: "scard iform" }, h("div", { class: "fhead" }, status), form, err);
  if (p.can.test) {
    const tri = trials.get(key);
    const out = tri && !tri.running ? h("pre", { class: tri.ok ? "" : "bad", role: "status", text: tr(tri.text) }) : null;
    box.append(h("div", { class: "try" }, h("div", { class: "step-h" }, t("tryNow"),
      h("button", { type: "button", class: "btn small", text: tri?.running ? t("trying") : t("tryBtn"), disabled: !!tri?.running, onclick: async () => {
        trials.set(key, { running: true }); render();
        trials.set(key, await itemOp({ op: "test", provider: p.id, kind: kind.id, id: it.id, values: { ...values } })); render();
      } })), out));
  }
  return box;
}

// ------------------------------------------------------------------ branchements
function updateSettings(d) {
  if (!d) return;
  if (d.lang) setLang(d.lang);
  settings = { list: d.list ?? [], plugins: d.plugins ?? [], slots: d.slots ?? [] };
  sections = d.sections ?? [];
  render();
}
/** « Ouvre les réglages d'Orca » : page demandée, montrée dès que l'élément est connu (10 s au plus). */
let pendingFocus = null;
function focusOn(target) {
  pendingFocus = target;
  setTimeout(() => { if (pendingFocus === target) pendingFocus = null; }, 10_000);
  if (applyFocus()) render();
}
function applyFocus() {
  const f = pendingFocus;
  const p = f && items.providers.find((x) => x.id === f.provider);
  const it = p?.items.find((x) => x.id === f.id);
  if (!it) return false;
  pendingFocus = null;
  section = f.section;
  detailStack = [{ pid: p.id, iid: it.id }];
  query = "";
  $("search").value = "";
  navAnim = "fwd";
  return true;
}

function updateItems(d) {
  if (!d) return;
  if (d.lang) setLang(d.lang);
  const { libraries: libs, others } = splitLibraries(d.providers ?? []);
  const key = JSON.stringify(others);
  const shape = libraryShape(libs);
  // Seul l'avancement d'un téléchargement a bougé : on met à jour les barres, sans redessiner la page (ni clignoter).
  const onlyProgress = key === itemsKey && shape === libShape;
  items = { providers: others };
  libraries = libs;
  itemsKey = key; libShape = shape;
  const focused = applyFocus();
  if (onlyProgress && !focused) { patchLibraries(); return; }
  render();
  if (library) drawLibrary();
}

$("search").addEventListener("input", (e) => { query = e.target.value.trim(); deferred = false; render(); });
$("search").addEventListener("keydown", (e) => { if (e.key === "Escape") setQuery(""); });
// Échap sur une page d'élément : retour (sauf dans un champ ou une fenêtre ouverte).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !detailStack.length || dlg.open || e.defaultPrevented) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  e.preventDefault();
  closeDetail(1);
});
$("assistant-btn").onclick = () => { section = sections.find((x) => x.view === "assistant")?.id ?? section; setQuery(""); };
$("undo").onclick = async () => {
  if (!api) { toast(`${t("demoNote")}0`); return; }
  try { const r = await api.undo(); toast(r?.text || t("undone"), !r?.ok); } catch (e) { toast(String(e?.message ?? e), true); }
};
// Un champ quitté : le rendu en attente peut se faire.
document.addEventListener("focusout", () => { if (deferred) setTimeout(() => { if (deferred) render(); }, 0); });

applyStaticTexts();
if (api) {
  api.onUpdate(updateSettings);
  api.onItems?.(updateItems);
  api.onFocus?.(focusOn);
  api.onOnboarding?.(updateOnboarding);
  api.onboardingState?.().then(updateOnboarding);
  api.get().then(updateSettings);
  api.items?.().then(updateItems);
} else {
  // Hors de l'app : données d'exemple, chargées à part (jamais dans l'app).
  const { DEMO } = await import("./settings-demo.js");
  updateSettings(structuredClone(DEMO.settings));
  updateItems(structuredClone(DEMO.items));
}
render();
initAssistant();
