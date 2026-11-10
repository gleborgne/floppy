// Fenêtre des réglages : point d'entrée. Tout est généré depuis ce que les plugins déclarent (réglages du registre +
// fournisseurs d'éléments du catalogue, rubriques comprises). Aucune liste en dur : seuls les textes de la fenêtre sont
// dans settings-texts.js (fr / en). Sans window.floppySettings (ouverture hors de l'app), la page charge des données
// d'exemple (settings-demo.js).
//
// Modules : settings-state (état partagé, appels au noyau), settings-pages (rubriques), settings-slots (pages à rôles),
// settings-rows (lignes, listes, onglets), settings-detail (page d'un élément), settings-form (formulaire en place),
// settings-controls (réglages), settings-dialogs (ajout, catalogue, modèles). La page est décrite par des éléments
// virtuels (dom.js) : Preact ne change que ce qui diffère d'un dessin à l'autre.
import { initAssistant } from "./assistant.ts";
import { splitLibraries } from "./library.ts";
import { h, mount } from "./dom.ts";
import type { Child } from "./dom.ts";
import { Fragment } from "./vendor/preact.mjs";
import { configureFields } from "./fields.ts";
import { detailPage } from "./settings-detail.ts";
import { audioStates, dlg, drawEditor, refreshDialog } from "./settings-dialogs.ts";
import { addButton, navSections, onboardingBlock, pageHead, pageNodes } from "./settings-pages.ts";
import { tabify, tabsEnter } from "./settings-rows.ts";
import { navSummary } from "./settings-slots.ts";
import {
  $, S, api, applyStaticTexts, closeDetail, errText, onRender, pageOf, render, secLabel, sectionById, setLang, slotsOn, t, toast, tr,
} from "./settings-state.ts";

/** La recherche du haut. */
const searchBox = $<HTMLInputElement>("search");

configureFields({ t, tr, api, audioStates, render, drawEditor });

let deferred = false;   // un dessin attend que le champ en cours de saisie soit quitté
let pageKey = "";       // la page affichée (rubrique, page d'élément, recherche)
let pageAnim = "";      // son animation d'entrée, jouée une fois quand elle apparaît

function renderNav(): void {
  const nav = $("nav");
  nav.setAttribute("aria-label", t("navLabel"));
  const count = (page: string) => S.items.providers.filter((p) => p.layout !== "grid" && pageOf(p.section) === page).reduce((n, p) => n + p.items.length, 0);
  mount(h(Fragment, {},
    navSections().map((sec) => {
      const n = count(sec.id);
      const name = secLabel(sec.id);
      const sum = navSummary(sec.id);
      return h("button", { type: "button", class: "nav", key: sec.id, "data-initial": name.slice(0, 1), ...(sec.icon ? { "data-icon": sec.icon } : {}), ...(sec.id === S.section && !S.query ? { "aria-current": "page" } : {}),
        onclick: () => { S.section = sec.id; S.detailStack = []; S.navAnim = "fade"; setQuery(""); } },
      sum ? h("span", { class: "navt" }, h("span", { text: name }), h("small", { text: sum })) : name, !sum && n ? h("span", { class: "badge", text: String(n) }) : null);
    }),
    h("p", { class: "nav-note", text: t("navNote") })), nav);
}

function draw(): void {
  // Pendant qu'on tape dans un champ de la page, le dessin attend la fin de la saisie (le champ montrerait encore
  // l'ancienne valeur venue du noyau).
  const a = document.activeElement;
  if (a && $("content").contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && (a as HTMLInputElement).type !== "checkbox" && (a as HTMLInputElement).type !== "range" && (a as HTMLInputElement).type !== "search") { deferred = true; return; }
  deferred = false;
  // Page demandée absente du menu (hash inconnu, plugin retiré) : la première rubrique.
  const nav = navSections();
  if (nav.length && !nav.some((x) => x.id === S.section)) S.section = nav[0]?.id ?? S.section;
  $("assistant-btn").hidden = !S.sections.some((x) => x.view === "assistant");
  renderNav();
  const root = $("content");
  const showAssistant = sectionById(S.section)?.view === "assistant" && !S.query;
  root.hidden = showAssistant;
  $("pane-assistant").hidden = !showAssistant;
  $("assistant-btn").setAttribute("aria-pressed", String(showAssistant));
  if (showAssistant) return;
  tabsEnter(S.navAnim === "tab");
  const nodes: Child[] = [];
  let detail: Child = null;
  let key: string;
  if (S.query) {
    key = "search";
    nodes.push(h("div", { class: "page-head" }, h("div", {}, h("h2", { text: t("results") }), h("p", { text: `« ${S.query} »` }))));
    for (const sec of navSections()) {
      if (sec.view && sec.view !== "plugins") continue;
      const sub: Child[] = [];
      pageNodes(sec.id, sub);
      if (sub.some(Boolean)) nodes.push(h("div", { class: "block", key: sec.id }, h("h3", { text: secLabel(sec.id) }), ...sub));
    }
    if (nodes.length === 1) nodes.push(h("div", { class: "empty", text: t("noMatch") }));
  } else if (S.detailStack.length && (detail = detailPage())) {
    key = `item:${S.detailStack.map((d) => `${d.pid}/${d.iid}`).join(">")}`;
    nodes.push(detail);
  } else {
    key = `page:${S.section}`;
    // Rubrique Général : refaire le réglage de départ (fenêtre « Bienvenue »).
    const head = S.section === "general" && api?.openOnboarding
      ? h("button", { type: "button", class: "btn", text: t("firstSetup"), onclick: () => api?.openOnboarding() })
      : slotsOn(S.section).length ? null : addButton(S.section);
    const page: Child[] = [pageHead(S.section, head)];
    if (S.section === "general") page.push(onboardingBlock());
    pageNodes(S.section, page);
    nodes.push(...tabify(`page:${S.section}`, page));
    if (!S.settings.list.length && !S.items.providers.length) nodes.push(h("div", { class: "empty", text: api ? t("waiting") : "" }));
  }
  // Une autre page : nouvel élément (clé), qui entre avec son animation une seule fois ; la même page redessinée garde
  // ses éléments (pas d'animation, pas de clic perdu, le défilement reste).
  const moved = key !== pageKey;
  if (moved) { pageKey = key; pageAnim = S.navAnim && S.navAnim !== "tab" ? S.navAnim : ""; }
  S.navAnim = "";
  mount(h("div", { class: `pg${pageAnim ? ` anim-${pageAnim}` : ""}`, key }, nodes.filter(Boolean)), root);
  if (moved) root.scrollTop = 0;
}
onRender(draw);

function setQuery(q: string): void {
  S.query = q;
  if (q) S.detailStack = [];
  if (searchBox.value !== q) searchBox.value = q;
  render();
}

// ------------------------------------------------------------------ branchements
function updateSettings(d: SettingsSnapshot | null | undefined): void {
  if (!d) return;
  if (d.lang) setLang(d.lang);
  S.settings = { list: d.list ?? [], plugins: d.plugins ?? [], slots: d.slots ?? [] };
  S.sections = d.sections ?? [];
  render();
  refreshDialog(); // la fenêtre ouverte suit aussi (les étiquettes de langue de la bibliothèque)
}

/** « Ouvre les réglages d'Orca » : page demandée, montrée dès que l'élément est connu (10 s au plus). */
let pendingFocus: SettingsFocusTarget | null = null;
function focusOn(target: SettingsFocusTarget): void {
  pendingFocus = target;
  setTimeout(() => { if (pendingFocus === target) pendingFocus = null; }, 10_000);
  if (applyFocus()) render();
}
function applyFocus(): boolean {
  const f = pendingFocus;
  const p = f ? S.items.providers.find((x) => x.id === f.provider) : undefined;
  const it = f ? p?.items.find((x) => x.id === f.id) : undefined;
  if (!f || !p || !it) return false;
  pendingFocus = null;
  S.section = f.section;
  S.detailStack = [{ pid: p.id, iid: it.id }];
  S.query = "";
  searchBox.value = "";
  S.navAnim = "fwd";
  return true;
}

function updateItems(d: ItemsSnapshot | null | undefined): void {
  if (!d) return;
  if (d.lang) setLang(d.lang);
  const { libraries, others } = splitLibraries(d.providers ?? []);
  S.items = { providers: others };
  S.libraries = libraries;
  applyFocus();
  // Avancement d'un téléchargement, état qui change : Preact ne touche que ce qui a bougé.
  render();
  refreshDialog();
}

function updateOnboarding(s: OnboardingState | null | undefined): void {
  S.onb = s ?? null;
  if (S.section === "general" && !S.query && !S.detailStack.length) render();
}

searchBox.addEventListener("input", () => { S.query = searchBox.value.trim(); if (S.query) S.detailStack = []; render(); });
searchBox.addEventListener("keydown", (e) => { if (e.key === "Escape") setQuery(""); });
// Échap sur une page d'élément : retour (sauf dans un champ ou une fenêtre ouverte).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !S.detailStack.length || dlg.open || e.defaultPrevented) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  e.preventDefault();
  closeDetail(1);
});
$("assistant-btn").onclick = () => { S.section = S.sections.find((x) => x.view === "assistant")?.id ?? S.section; setQuery(""); };
$("undo").onclick = async () => {
  if (!api) { toast(`${t("demoNote")}0`); return; }
  try { const r = await api.undo(); toast(r?.text || t("undone"), !r?.ok); } catch (e) { toast(errText(e), true); }
};
// Un champ quitté : le dessin en attente peut se faire.
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
  const { DEMO } = await import("./settings-demo.ts");
  updateSettings(structuredClone(DEMO.settings));
  updateItems(structuredClone(DEMO.items));
}
render();
initAssistant();
