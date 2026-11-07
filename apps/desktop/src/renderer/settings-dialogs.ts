// Fenêtre des réglages : les fenêtres par-dessus la page (une seule <dialog>, trois usages) :
// - la fenêtre d'ajout d'un élément (modifier se fait sur la page de l'élément) ;
// - le catalogue des plugins (« + Ajouter un plugin ») ;
// - la bibliothèque de modèles à télécharger, avec ses barres d'avancement.
import { h, icon, mount } from "./dom.ts";
import type { Child, Ev } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { Fragment } from "./vendor/preact.mjs";
import { formNode, resetFieldState, visible } from "./fields.ts";
import type { FieldAudioState } from "./fields.ts";
import { addOutcome, missingFields as missingOf } from "./form-rules.ts";
import { downloadSummary, librariesFor, percent } from "./library.ts";
import { offersOf } from "./slot-sources.ts";
import { abortRecording } from "./voice-recorder.ts";
import { trialPlayer } from "./settings-form.ts";
import { $, S, appProviders, defaultsOf, itemOp, openDetail, pageOf, playAudio, quickOp, render, secLabel, t, toast, tr } from "./settings-state.ts";

export const dlg = $<HTMLDialogElement>("editor");
/** Le contenu de la fenêtre, et sa forme (classe : catalogue, bibliothèque). */
const show = (cls: string, ...kids: Child[]): void => {
  dlg.classList.toggle("catalog", cls === "catalog" || cls === "library");
  dlg.classList.toggle("library", cls === "library");
  mount(h(Fragment, {}, ...kids), dlg);
  if (!dlg.open) dlg.showModal();
};

// ------------------------------------------------------------------ fenêtre d'ajout
/** Un type d'élément qu'on peut ajouter, avec son fournisseur. */
export interface KindChoice { provider: ItemProvider; kind: ItemKind }
/** Ce que la fenêtre d'ajout reçoit à l'ouverture. */
export interface EditorInit { mode?: string; kinds?: KindChoice[] }
/** Résultat d'un essai : en cours, ou la réponse du noyau (ou une erreur de saisie). */
type Trial = { running?: boolean; ok?: boolean; text?: string; audio?: string; children?: ItemChild[] };
interface EditorState {
  kinds: KindChoice[]; provider: ItemProvider | null; kind: ItemKind | null; values: Record<string, unknown>; step: number;
  trial: Trial | null; busy: boolean;
}
/** Le formulaire d'ajout quand un type est choisi (étape 2). */
type ChosenEditor = EditorState & { provider: ItemProvider; kind: ItemKind };
let ed: EditorState | null = null;

/** Enregistreurs des formulaires : « ed/<champ> » (fenêtre d'ajout) ou « fournisseur/élément/<champ> » (page de l'élément). */
export const audioStates = new Map<string, FieldAudioState>();
/** Fenêtre d'ajout fermée ou rouverte : son micro s'arrête, son enregistrement repart de zéro. */
function resetEditorState() {
  for (const [k, st] of audioStates) if (k.startsWith("ed/")) { abortRecording(st); audioStates.delete(k); }
  resetFieldState("ed");
}

export function openEditor(init: EditorInit): void {
  catalog = null; library = null;
  resetEditorState();
  ed = { kinds: init.kinds ?? [], provider: null, kind: null, values: {}, step: 1, trial: null, busy: false };
  if (ed.kinds.length === 1 && ed.kinds[0]) chooseKind(ed.kinds[0]);
  drawEditor();
}

function chooseKind(k: KindChoice): void {
  if (!ed) return;
  ed.provider = k.provider;
  ed.kind = k.kind;
  ed.values = defaultsOf(k.kind);
  ed.trial = null;
  ed.step = 2;
}

function closeEditor() { if (dlg.open) dlg.close(); ed = null; resetEditorState(); }
dlg.addEventListener("close", () => { resetEditorState(); ed = null; catalog = null; library = null; render(); });
dlg.addEventListener("cancel", () => { ed = null; });

async function runTrial(): Promise<void> {
  const e = ed as ChosenEditor; // Échap pendant l'attente met `ed` à null : on garde notre propre référence.
  e.busy = true; e.trial = { running: true };
  drawEditor();
  const r = await itemOp({ op: "test", provider: e.provider.id, kind: e.kind.id, values: e.values });
  e.busy = false; e.trial = r;
  if (r.ok && r.audio && ed === e) playAudio(r.audio);
  if (ed === e) drawEditor();
}

async function submit(): Promise<void> {
  if (!ed || !ed.kind) return;
  const miss = missingOf(ed.kind.fields, ed.values, visible);
  if (miss.length) { ed.trial = { ok: false, text: `${t("required")} : ${miss.map((f) => tr(f.label)).join(", ")}` }; drawEditor(); return; }
  const e = ed as ChosenEditor; // Échap pendant l'attente met `ed` à null : on garde notre propre référence.
  e.busy = true; drawEditor();
  const r = await itemOp({ op: "add", provider: e.provider.id, kind: e.kind.id, values: e.values });
  e.busy = false;
  const o = addOutcome(r, ed === e, { done: t("done"), refused: t("refused") });
  if (o.close) closeEditor();
  if (o.toast) toast(o.toast.text, o.toast.bad);
  if (o.error) { e.trial = { ok: false, text: o.error }; drawEditor(); }
}

export function drawEditor(): void {
  if (!ed) return;
  const e = ed;
  const { kind, provider } = e;
  const title = `${t("addTitle")}${kind ? " : " + tr(kind.label) : ""}`;
  const body: Child[] = [];
  const foot: Child[] = [];
  const closeBtn = h("button", { type: "button", class: "btn", text: t("cancel"), onclick: closeEditor });
  if (e.step === 1) {
    body.push(h("div", { class: "step-h" }, h("span", { class: "step", text: "1" }), t("stepType")));
    if (!e.kinds.length) body.push(h("div", { class: "empty", text: t("noKinds") }));
    body.push(h("div", { class: "types" }, e.kinds.map((k) => h("button", { type: "button", class: "type", onclick: () => { chooseKind(k); drawEditor(); } },
      h("span", { class: "l" }, h("strong", { text: tr(k.kind.label) }), k.kind.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null, h("span", { class: "badge", text: tr(k.provider.label) })),
      k.kind.description ? h("small", { text: tr(k.kind.description) }) : null))));
    foot.push(closeBtn);
  } else {
    if (!kind || !provider) return;
    // Numéros d'étape : « 1. choisir le type » existe seulement s'il y a plusieurs types à ajouter.
    const n0 = e.kinds.length > 1 ? 1 : 0;
    body.push(h("div", { class: "step-h" }, h("span", { class: "step", text: String(n0 + 1) }), tr(kind.label), kind.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null));
    if (kind.description) body.push(h("div", { class: "desc", text: tr(kind.description) }));
    const hasForm = kind.fields.length > 0;
    if (hasForm) body.push(formNode(kind, e.values, { redraw: drawEditor }));
    const trial = e.trial && !e.trial.running ? e.trial : null;
    if (provider.can.test && hasForm) {
      body.push(h("div", { class: "try" },
        h("div", { class: "step-h" }, h("span", { class: "step", text: String(n0 + 2) }), t("stepTry"),
          h("button", { type: "button", class: "btn small", text: e.trial?.running ? t("trying") : t("tryBtn"), disabled: e.busy, onclick: runTrial })),
        trial ? h("pre", { class: trial.ok ? "" : "bad", role: "status", text: trial.text ?? "" }) : null,
        trial?.audio ? trialPlayer(trial.audio) : null,
        trial?.children?.length ? h("ul", { class: "plainlist" }, trial.children.map((c) => h("li", { text: [tr(c.label), tr(c.detail)].filter(Boolean).join(" — ") }))) : null));
    } else if (trial) body.push(h("pre", { class: "bad", role: "alert", text: trial.text }));
    if (e.kinds.length > 1) foot.push(h("button", { type: "button", class: "btn", "aria-label": t("stepType"), onclick: () => { e.step = 1; e.trial = null; drawEditor(); } }, icon("arrow-left")));
    foot.push(closeBtn);
    if (hasForm) foot.push(h("button", { type: "button", class: "btn pri", disabled: e.busy, text: t("addAndGo"), onclick: submit }));
  }
  show("", h("div", { class: "ed-head" }, h("h2", { id: "editor-title", text: title })), h("div", { class: "ed-body" }, body), h("div", { class: "ed-foot" }, foot));
}

/** Ouvre les réglages d'un élément : sa page, avec son formulaire en place (la fenêtre ne sert plus qu'à ajouter). */
export function openItemSettings(p: ItemProvider, it: ProviderItem): void {
  if (dlg.open) dlg.close();
  openDetail(p, it);
}

// ------------------------------------------------------------------ catalogue des plugins
/** Rôle demandé au catalogue : les services qu'il remplit, et le nom du rôle. */
export interface CatalogRole { services: string[]; label: string }
interface CatalogState { category: string; source: string; role?: CatalogRole | undefined }
let catalog: CatalogState | null = null;

/**
 * Ouvre le catalogue. Depuis un rôle (role = { services, label }, ex. le mot d'activation) : seulement les plugins
 * qui fournissent un de ces services ; la pastille « Pour : … » enlève le filtre. Sinon : la rubrique de la page.
 */
export function openCatalogue(page: string, role?: CatalogRole): void {
  ed = null; library = null;
  const cats = appProviders().map((p) => p.section);
  catalog = role?.services?.length ? { category: "", source: "builtin", role } : { category: cats.includes(page) ? page : "", source: "builtin" };
  drawCatalogue();
}
export const roleOf = (slot: SettingsSlot): CatalogRole => ({ services: [slot.service], label: tr(slot.label) });
/** Une fiche (type d'ajout) remplit-elle le rôle demandé ? */
const fitsRole = (services: string[] | undefined): boolean => {
  const role = catalog?.role;
  return !role || (services ?? []).some((s) => role.services.includes(s));
};

function drawCatalogue() {
  if (!catalog) return;
  const cat = catalog;
  const apps = appProviders();
  const kindsOfApp = (p: ItemProvider) => p.kinds.filter((k) => fitsRole(k.provides));
  const catBtn = (id: string, label: string, n: number) => h("button", { type: "button", class: `ccat${cat.category === id ? " on" : ""}`, "aria-pressed": String(cat.category === id), onclick: () => { cat.category = id; drawCatalogue(); } }, h("span", { text: label }), h("small", { text: String(n) }));
  const nav = h("nav", { class: "ccats", "aria-label": t("categories") },
    catBtn("", t("all"), apps.reduce((n, p) => n + kindsOfApp(p).length, 0)),
    apps.filter((p) => kindsOfApp(p).length).map((p) => catBtn(p.section, secLabel(p.section), kindsOfApp(p).length)));
  const cards = [];
  for (const p of apps.filter((x) => !cat.category || x.section === cat.category)) {
    for (const k of kindsOfApp(p)) {
      const it = p.items.find((x) => x.kind === k.id);
      const foot = it
        ? [h("span", { class: it.enabled ? "done" : "off", text: it.enabled ? t("installed") : t("installedOff") }),
          h("button", { type: "button", class: "btn small", text: t("settingsBtn"), onclick: () => { catalog = null; openItemSettings(p, it); } })]
        : [h("span"), h("button", { type: "button", class: "btn small pri", text: t("add"), onclick: async () => {
          if (k.fields.length) { catalog = null; openEditor({ mode: "add", kinds: [{ provider: p, kind: k }] }); return; }
          const r = await quickOp({ op: "add", provider: p.id, kind: k.id, values: {} });
          if (r.ok) drawCatalogue();
        } })];
      cards.push(h("div", { class: "ccard", key: `${p.id}/${k.id}` },
        h("div", { class: "ct" }, h("strong", { text: tr(k.label) }), cat.category ? null : h("span", { class: "chip", text: secLabel(p.section) })),
        h("p", { text: tr(k.description) }),
        h("div", { class: "tags" }, h("span", { class: "chip", text: t("builtin") }), k.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null),
        h("div", { class: "cfoot" }, foot)));
    }
  }
  // « Créer le tien » : les types d'éléments que les plugins installés savent créer (MCP local, modèle GGUF…).
  // Depuis un rôle : seulement les fournisseurs qui l'offrent (un modèle ONNX de transcription ne fait pas un mot d'activation).
  const own = S.items.providers.filter((p) => !p.id.startsWith("apps-") && p.can.add && p.kinds.length && fitsRole(offersOf(p)) && (!cat.category || pageOf(p.section) === cat.category));
  const mine = own.flatMap((p) => p.kinds.map((k) => h("div", { class: "ccard mine", key: `${p.id}/${k.id}` }, h("strong", { text: tr(k.label) }), h("p", { text: tr(k.description) }),
    h("div", { class: "tags" }, h("span", { class: "chip", text: tr(p.label) }), k.cloud ? h("span", { class: "chip cloud", text: t("cloud") }) : null),
    h("div", { class: "cfoot" }, h("span"), h("button", { type: "button", class: "btn small", text: t("create"), onclick: () => { catalog = null; openEditor({ mode: "add", kinds: [{ provider: p, kind: k }] }); } })))));
  const list = h("div", { class: "clist" },
    h("div", { class: "csrc", role: "group", "aria-label": t("source") },
      h("button", { type: "button", class: "pill on", "aria-pressed": "true", text: t("builtinMany") }),
      h("button", { type: "button", class: "pill", disabled: true, text: t("marketSoon") }),
      cat.role ? h("button", { type: "button", class: "pill on", title: t("forRoleTip"), "aria-label": `${t("forRole")} : ${cat.role.label} — ${t("forRoleTip")}`, text: `${t("forRole")} : ${cat.role.label} ×`, onclick: () => { cat.role = undefined; drawCatalogue(); } }) : null),
    !cards.length && cat.role ? h("div", { class: "empty-line", text: t("noneCompatible") }) : h("div", { class: "cgrid" }, cards),
    mine.length ? [h("h3", { class: "chd", text: t("createOwn") }), h("div", { class: "cgrid" }, mine)] : null);
  show("catalog",
    h("div", { class: "ed-head chead" }, h("h2", { id: "editor-title", text: t("addPlugin") }),
      h("button", { type: "button", class: "btn small", "aria-label": t("close"), text: "×", onclick: () => { catalog = null; dlg.close(); } })),
    h("div", { class: "cbody" }, nav, list));
}

// ------------------------------------------------------------------ bibliothèque de modèles (téléchargements)
// Une fenêtre par rôle (ex. Transcription) : les modèles choisis par Floppy, la recherche en ligne si le plugin la
// propose, une barre d'avancement par téléchargement.
interface LibraryState {
  service: string; source: string; role: string; raw: string; query: string; results: [ItemProvider, ProviderItem][] | null;
  searching: boolean; armed: string;
}
let library: LibraryState | null = null;

/** Texte du bouton : « Télécharger des modèles » ou « … · 1 en cours · 42 % ». */
function libSummary(service: string, source: string): string {
  const { count, progress } = downloadSummary(librariesFor(S.libraries, service, source || undefined));
  if (!count) return "";
  return ` · ${count} ${t("dlRunning")}${progress === null ? "" : ` · ${percent(progress)} %`}`;
}

export function libButton(service: string, source: string, role: string): VNode {
  return h("button", { type: "button", class: "btn small lib", onclick: () => openLibrary(service, source, role) },
    icon("download"), h("span", { text: t("getModels") }), h("span", { class: "libsum", text: libSummary(service, source) }));
}

function openLibrary(service: string, source: string, role: string): void {
  ed = null; catalog = null;
  library = { service, source, role, raw: "", query: "", results: null, searching: false, armed: "" };
  drawLibrary(true);
}

const libsOpen = () => (library ? librariesFor(S.libraries, library.service, library.source || undefined) : []);

/** L'état à jour d'un élément : celui de la liste (avancement), sinon celui du résultat de recherche. */
function liveItem(providerId: string, id: string): ProviderItem | undefined {
  const p = S.libraries.find((x) => x.id === providerId);
  return p?.items.find((x) => x.id === id) ?? library?.results?.find(([pp, it]) => pp.id === providerId && it.id === id)?.[1];
}

async function libAction(p: ItemProvider, it: ProviderItem, action: string): Promise<void> {
  const r = await quickOp({ op: "action", provider: p.id, id: it.id, action });
  if (r.ok && action === "download" && library?.results) drawLibrary();
}

/** Barre d'avancement + texte (« 42 % · 1,2 / 2,9 Go »). Largeur par le CSSOM : la politique de sécurité refuse l'attribut style. */
export function progressNode(label: string, progress: number | undefined, statusText: string, good = false): VNode {
  const pct = percent(progress);
  return h("div", { class: "lprog" },
    h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": label }, h("i", { style: { width: `${pct}%` } })),
    h("span", { class: good ? "lst good" : "lst", text: statusText }));
}

function libRow(p: ItemProvider, it: ProviderItem): VNode {
  const acts = it.actions ?? [];
  // Un seul bouton plein par écran (DESIGN.md) : Télécharger reste secondaire, avec son icône.
  const btn = (a: ItemAction, ic?: string | null) => h("button", { type: "button", class: `btn small${ic ? " lib" : ""}`, "aria-label": `${tr(a.label)} : ${tr(it.label)}`, onclick: () => libAction(p, it, a.id) },
    ic ? icon(ic) : null, h("span", { text: tr(a.label) }));
  const side = [];
  if (it.status === "loading") {
    side.push(progressNode(tr(it.label), it.progress, tr(it.statusText)), ...acts.map((a) => btn(a)));
  } else {
    if (it.status === "ok") side.push(h("span", { class: "lst good" }, icon("check"), h("span", { text: tr(it.statusText) })));
    const main = acts.find((a) => a.id === "download" || a.id === "use");
    for (const a of acts.filter((x) => x !== main)) {
      if (a.id !== "remove") { side.push(btn(a)); continue; }
      // Supprimer : le 1er clic arme, le 2e confirme (5 s).
      const k = `${p.id}/${it.id}`;
      const sure = library?.armed === k;
      side.push(h("button", { type: "button", class: `btn small${sure ? " danger" : ""}`, text: sure ? t("libConfirm") : tr(a.label), "aria-label": `${sure ? t("libConfirm") : tr(a.label)} : ${tr(it.label)}`,
        onclick: () => {
          if (!library) return;
          if (!sure) { library.armed = k; drawLibrary(); setTimeout(() => { if (library?.armed === k) { library.armed = ""; drawLibrary(); } }, 5000); return; }
          library.armed = "";
          void libAction(p, it, "remove");
        } }));
    }
    if (main) side.push(btn(main, main.id === "download" ? "download" : null));
  }
  const tags = (it.tags ?? []).map((x) => h("span", { class: "chip tag", text: tr(x) }));
  return h("div", { class: "srow lrow", key: `${p.id}/${it.id}` },
    h("div", { class: "rt" },
      h("div", { class: "rn" }, h("strong", { text: tr(it.label) })),
      it.detail ? h("div", { class: "rd", text: tr(it.detail) }) : null,
      it.status === "error" ? h("div", { class: "lerr", role: "alert", text: tr(it.statusText) }) : null,
      tags.length ? h("div", { class: "tags" }, tags) : null),
    h("div", { class: "lside" }, side));
}

let libTimer = 0;
async function runLibrarySearch() {
  if (!library) return;
  const q = library.query;
  const searchable = libsOpen().filter((p) => p.can.search);
  if (q.length < 2) { library.results = null; library.searching = false; drawLibrary(); return; }
  library.searching = true; drawLibrary();
  const found: [ItemProvider, ProviderItem][] = [];
  for (const p of searchable) {
    const r = await itemOp({ op: "search", provider: p.id, query: q });
    if (!r.ok) toast(r.text || t("refused"), true);
    for (const it of r.items ?? []) found.push([p, it]);
  }
  if (!library || library.query !== q) return; // une autre recherche est partie
  library.results = found; library.searching = false;
  drawLibrary();
}

/** first : la fenêtre vient de s'ouvrir (le focus va à la recherche, sinon le navigateur le pose sur « Fermer »). */
export function drawLibrary(first = false): void {
  if (!library) return;
  const lib = library;
  const libs = libsOpen();
  const searchable = libs.filter((p) => p.can.search);
  const search = searchable.length ? h("div", { class: "lsearch" }, h("input", {
    type: "search", class: "lsinput", "aria-label": t("libSearchLabel"), placeholder: tr(searchable[0]?.searchHint) || t("libSearchLabel"), value: lib.raw,
    oninput: (e: Ev) => { lib.raw = e.currentTarget.value; lib.query = lib.raw.trim(); clearTimeout(libTimer); libTimer = setTimeout(runLibrarySearch, 400); },
    onkeydown: (e: Ev<KeyboardEvent>) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(libTimer); void runLibrarySearch(); } },
  })) : null;
  const nodes = [];
  if (library.query.length >= 2 && searchable.length) {
    nodes.push(h("h3", { class: "shead" }, h("span", { text: t("libResults") })));
    nodes.push(h("div", { class: "scard" }, !library.results?.length
      ? h("div", { class: "empty-line", text: library.searching ? t("libSearching") : t("libNoResult") })
      : library.results.map(([p, it]) => libRow(p, liveItem(p.id, it.id) ?? it))));
  }
  for (const p of libs) {
    if (!p.items.length) continue;
    nodes.push(h("h3", { class: "shead" }, h("span", { text: libs.length > 1 ? tr(p.label) : t("libKnown") }), h("span", { class: "sub", text: tr(p.description) || t("libKnownNote") })));
    nodes.push(h("div", { class: "scard" }, p.items.map((it) => libRow(p, it))));
  }
  if (!nodes.length) nodes.push(h("div", { class: "empty-line", text: t("noItems") }));
  show("library",
    h("div", { class: "ed-head chead" },
      h("h2", { id: "editor-title" }, h("span", { text: t("libTitle") }), library.role ? h("span", { class: "sub", text: ` · ${t("libFor")} ${library.role}` }) : null),
      h("button", { type: "button", class: "btn small", "aria-label": t("close"), text: "×", onclick: () => dlg.close() })),
    search, h("div", { class: "lbody", "aria-live": "polite" }, nodes),
    h("p", { class: "lfoot", text: t("libNote") }));
  if (first && search) queueMicrotask(() => dlg.querySelector<HTMLElement>(".lsinput")?.focus());
}

/** Données reçues : la fenêtre ouverte se redessine aussi (avancement d'un téléchargement, élément ajouté). */
export function refreshDialog(): void {
  if (library) drawLibrary();
  else if (catalog) drawCatalogue();
}
