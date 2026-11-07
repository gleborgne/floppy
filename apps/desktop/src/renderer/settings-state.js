// Fenêtre des réglages : l'état partagé par ses modules et les outils communs (textes, rubriques, slots, appels au
// noyau, navigation). Un module change l'état puis appelle render() ; settings.js dessine (Preact ne change que ce qui
// diffère). Aucune liste en dur : tout vient de ce que les plugins déclarent.
import { I } from "./settings-texts.js";
import { offersOf } from "./slot-sources.js";

/** Pont vers l'app (preload) ; absent hors de l'app : la page montre des données d'exemple. */
export const api = window.floppySettings;
export const $ = (id) => document.getElementById(id);

/** L'état de la fenêtre. Les modules le lisent et le changent, puis appellent render(). */
export const S = {
  lang: "fr",
  /** Rubriques : [{ id, label, description?, order, icon?, parent?, merge?, view? }]. */
  sections: [],
  settings: { list: [], plugins: [], slots: [] },
  items: { providers: [] },
  /** Fournisseurs « library » (modèles à télécharger), montrés dans leur fenêtre. */
  libraries: [],
  /** Rubrique affichée ; vide : la première du menu. */
  section: location.hash.slice(1),
  query: "",
  /** Pages d'éléments ouvertes : [{ pid, iid }], de la rubrique vers l'élément le plus profond. */
  detailStack: [],
  /** Transition du prochain dessin : "fwd" (on avance), "back" (on revient), "fade" (autre rubrique), "tab" (autre onglet). */
  navAnim: "",
  /** Slot en cours de changement (le chargement d'un modèle prend du temps). */
  pendingSlot: "",
  /** « fournisseur/id » en attente de confirmation de suppression. */
  removing: "",
  /** Dernier état de l'installation de départ (onboarding.state du noyau). */
  onb: null,
};

let draw = () => {};
/** settings.js donne sa fonction de dessin. */
export function onRender(f) { draw = f; }
/** Redessine la fenêtre (Preact : seuls les changements touchent la page). */
export function render() { draw(); }

// ------------------------------------------------------------------ textes (fr / en)
export const t = (k) => I[S.lang]?.[k] ?? I.fr[k] ?? k;
/** Texte du noyau : chaîne simple, ou { fr, en }. */
export const tr = (x) => {
  if (x === undefined || x === null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "object") return x[S.lang] ?? x.fr ?? Object.values(x).find((v) => typeof v === "string") ?? "";
  return String(x);
};

export function applyStaticTexts() {
  document.documentElement.lang = S.lang;
  document.title = `Floppy — ${t("title")}`;
  $("title").textContent = t("title");
  $("search").placeholder = t("search");
  $("search").setAttribute("aria-label", t("searchLabel"));
  $("undo").textContent = t("undo");
  $("assistant-btn").textContent = t("assistant");
}

export function setLang(l) {
  if (!I[l] || l === S.lang) return;
  S.lang = l;
  applyStaticTexts();
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
/** La recherche du haut : vrai si un des textes la contient (ou s'il n'y a pas de recherche). */
export const matches = (...texts) => !S.query || texts.some((x) => norm(tr(x)).includes(norm(S.query)));

// ------------------------------------------------------------------ rubriques (fournies par le noyau et les plugins)
/** Un id de rubrique inconnu tombe dans « plugins ». */
export const FALLBACK = "plugins";
export const sectionById = (id) => S.sections.find((x) => x.id === id);
/** Rubrique de la page : une sous-rubrique (parent connu) s'affiche dans la page de son parent ; un id inconnu va dans « plugins ». */
export const pageOf = (id) => {
  let sec = sectionById(id);
  if (!sec) return FALLBACK;
  for (let i = 0; sec.parent && sectionById(sec.parent) && i < 8; i++) sec = sectionById(sec.parent);
  return sec.id;
};
export const secLabel = (id) => tr(sectionById(id)?.label) || id;

// ------------------------------------------------------------------ slots (choix d'éléments, faits par le noyau)
// Un slot (ex. « Cerveau principal », « Voix ») choisit un élément offert par un plugin. Le noyau fait tourner l'élément
// choisi seulement quand quelqu'un s'en sert. La fenêtre ne connaît aucun slot : tout vient de settings.slots.
export const slotsOn = (page) => (S.settings.slots ?? []).filter((x) => pageOf(x.section) === page);
export const slotSetting = (slot) => S.settings.list.find((x) => x.key === `slot.${slot.id}`);
/** Slots qu'un fournisseur d'éléments peut remplir. */
export const slotsFor = (p) => (S.settings.slots ?? []).filter((x) => offersOf(p).includes(x.service));
export const valueOf = (p, it) => `${p.source}/${it.id}`;
/** L'élément est-il proposé pour ce slot (disponible et offert maintenant) ? */
export const canFill = (slot, p, it) => (slotSetting(slot)?.options ?? []).some((o) => o.value === valueOf(p, it));
export const slotLabelOf = (slot) => {
  if (slot.value === "@none") return tr(slot.none) || t("noneChosen");
  const o = (slotSetting(slot)?.options ?? []).find((x) => x.value === slot.value);
  return o ? tr(o.label) : slot.value;
};
export const slotStateText = (slot) => slot.state === "starting" ? t("loading") : slot.state === "idle" ? t("idle")
  : slot.state === "error" ? `${t("failed")} : ${tr(slot.error)}` : "";
/** Un slot de ce fournisseur sert-il en ce moment (actif, en démarrage, ou en panne visible) ? */
export const provBusy = (p) => slotsFor(p).some((x) => ["active", "starting", "error"].includes(x.state));
/** Slots dont cet élément est le choix. */
export const filledBy = (p, it) => slotsFor(p).filter((x) => x.value === valueOf(p, it));
export const modeSlotOf = (page) => slotsOn(page).find((x) => x.display === "mode");
/** Applications : plugins qu'on ajoute, allume, éteint ou retire (fournisseurs « apps-… »). */
export const appProviders = () => S.items.providers.filter((p) => p.id.startsWith("apps-"));
/** Onglet affiché, par slot ou par page. */
export const uiTab = new Map();

export async function setSlot(slot, value) {
  S.pendingSlot = slot.id;
  render();
  try { await setValue(`slot.${slot.id}`, value); } finally { S.pendingSlot = ""; render(); }
}

/** Active un élément ; dans l'onglet d'un mode qui n'est pas en service, passe aussi dans ce mode. */
export async function activate(slot, value, page) {
  await setSlot(slot, value);
  const mode = modeSlotOf(page);
  if (mode && mode !== slot && uiTab.get(mode.id) === "@none" && mode.value !== "@none") await setSlot(mode, "@none");
}

// ------------------------------------------------------------------ appels au noyau
let toastTimer = 0;
export function toast(text, bad) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), bad ? 6000 : 3500);
}

export async function setValue(key, value) {
  if (!api) {
    const s = S.settings.list.find((x) => x.key === key);
    if (s) s.value = value;
    const slot = (S.settings.slots ?? []).find((x) => `slot.${x.id}` === key);
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

export async function itemOp(op) {
  if (!api) { toast(`${t("demoNote")}${op.op} ${op.provider}`); return { ok: true, text: `${t("demoNote")}${op.op}` }; }
  try { return (await api.itemOp(op)) ?? { ok: false, text: t("refused") }; }
  catch (e) { return { ok: false, text: String(e?.message ?? e) }; }
}

export async function quickOp(op) {
  const r = await itemOp(op);
  toast(r.text || (r.ok ? t("done") : t("refused")), !r.ok);
  if (r.ok && r.audio) playAudio(r.audio);
  return r;
}

/** Un seul son à la fois (« Écouter » d'une voix, essai) : le suivant coupe le précédent. */
let playing = null;
export function playAudio(src) {
  playing?.pause();
  playing = new Audio(src);
  void playing.play().catch(() => {});
}

/** Valeurs par défaut d'un type d'élément (formulaire neuf). */
export function defaultsOf(kind) {
  const v = {};
  for (const f of kind.fields) if (f.default !== undefined) v[f.key] = f.default;
  return v;
}

// ------------------------------------------------------------------ navigation entre pages d'éléments
/** Ouvre la page d'un élément (par-dessus la page courante). */
export function openDetail(p, it) {
  S.detailStack.push({ pid: p.id, iid: it.id });
  S.navAnim = "fwd";
  render();
}
/** Remonte d'un cran (n = 1) ou jusqu'à la rubrique (n = Infinity). */
export function closeDetail(n = 1) {
  S.detailStack = S.detailStack.slice(0, Math.max(0, S.detailStack.length - n));
  S.navAnim = "back";
  render();
}
