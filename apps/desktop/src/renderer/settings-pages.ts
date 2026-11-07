// Fenêtre des réglages : le contenu d'une rubrique (ses réglages, ses fournisseurs d'éléments, ses slots), le menu
// des rubriques, et les blocs propres à certaines pages (installation de départ, état des plugins).
import { h } from "./dom.ts";
import type { Child } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { installSummary, rowStatus } from "./onboarding-view.ts";
import { isLight } from "./tab-rules.ts";
import { settingsBlocks } from "./settings-controls.ts";
import { openCatalogue, openEditor, progressNode } from "./settings-dialogs.ts";
import { avatarGrid, providerCard, rowList, visibleItems } from "./settings-rows.ts";
import type { RowEntry } from "./settings-rows.ts";
import { slotPage } from "./settings-slots.ts";
import { FALLBACK, S, appProviders, matches, pageOf, secLabel, sectionById, slotsOn, t, tmap, tr } from "./settings-state.ts";
import type { KindChoice } from "./settings-dialogs.ts";

/** Rubriques du menu : sans parent, et avec du contenu (réglages, éléments) ou une vue spéciale. */
export function navSections(): SettingsSection[] {
  const filled = (id: string) => S.settings.list.some((s) => pageOf(s.section) === id) || S.items.providers.some((p) => pageOf(p.section) === id);
  // Une rubrique rattachée à un élément (ex. la Veille, réglée sous sa tâche) n'a pas d'entrée dans le menu.
  const attached = new Set(S.items.providers.flatMap((p) => p.items.map((it) => it.section).filter((x): x is string => !!x)));
  return S.sections.filter((x) => !x.parent && !attached.has(x.id) && (x.view || filled(x.id)));
}

export function pageHead(page: string, extra?: Child): VNode {
  return h("div", { class: "page-head" }, h("div", {}, h("h2", { text: secLabel(page) }), h("p", { text: tr(sectionById(page)?.description) })), extra);
}

// ------------------------------------------------------------------ bouton « Ajouter » d'une rubrique
function kindsOf(page: string): KindChoice[] {
  const out: KindChoice[] = [];
  for (const p of S.items.providers) if (pageOf(p.section) === page && p.can.add) for (const k of p.kinds) out.push({ provider: p, kind: k });
  return out;
}

export function addButton(page: string): VNode | null {
  const kinds = kindsOf(page);
  if (!kinds.length) return null;
  const only = [...new Set(kinds.map((k) => k.provider.id))];
  const one = only.length === 1 ? S.items.providers.find((p) => p.id === only[0]) : null;
  const label = one?.addLabel ? tr(one.addLabel) : `+ ${t("add")}`;
  const hasApps = appProviders().some((p) => p.section === page);
  return h("button", { type: "button", class: "btn pri", text: hasApps ? `+ ${t("addPlugin")}` : label, onclick: () => (hasApps ? openCatalogue(page) : openEditor({ mode: "add", kinds })) });
}

// ------------------------------------------------------------------ installation de départ (suivie depuis la rubrique Général)
/** Avancement de l'installation de départ : un morceau par ligne (programme, écoute, voix, cerveau), et ce qui s'est activé. */
export function onboardingBlock(): VNode | null {
  const onb = S.onb;
  const sum = installSummary(onb);
  if (!sum || !onb) return null;
  const words: Record<string, string> = { downloading: t("onbDownloading"), ready: t("onbReady"), waiting: t("onbWaiting"), failed: t("onbFailedRow") };
  const state = sum.running ? t("onbRunning") : sum.failed ? t("onbFailed") : t("onbDone");
  return h("div", { class: "block" }, h("h3", {}, t("onbTitle"), h("small", { text: `${state} · ${sum.ready} ${t("onbOf")} ${sum.total}` })),
    h("div", { class: "card" },
      onb.rows.map((r) => h("div", { class: "irow", key: r.role },
        h("div", { class: "grow" }, h("div", { class: "name", text: tr(r.label) }), h("div", { class: "desc", text: tmap("onbRoles")[r.role] ?? r.role })),
        progressNode(tr(r.label), r.progress ?? (r.state === "ready" ? 1 : 0), rowStatus(r, (k) => words[k] ?? k, S.lang), r.state === "ready"))),
      onb.notes?.length ? h("ul", { class: "onb-notes" }, onb.notes.map((n) => h("li", { text: tr(n) }))) : null));
}

function pluginsBlock(): VNode {
  const rows = S.settings.plugins.filter((p) => matches(p.id, p.plugin, ...(p.provides ?? []), tr(p.error)));
  return h("div", { class: "sgroup", "data-tab": secLabel(FALLBACK) }, h("h3", { text: secLabel(FALLBACK) }),
    h("div", { class: "card" },
      rows.length ? null : h("div", { class: "empty", text: t("noPlugins") }),
      rows.map((p) => {
        const cls = p.state === "active" ? "ok" : p.state === "error" ? "error" : "";
        const stateLabel = tmap("plugState")[p.state] ?? p.state;
        const bits = [p.plugin !== p.id ? p.plugin : "", ...(p.provides ?? [])].filter(Boolean);
        const err = tr(p.error) || (p.missing?.length ? `${t("waitsFor")} ${p.missing.join(", ")}` : "");
        return h("div", { class: "plug", key: p.id },
          h("span", { class: `dot ${cls}`.trim(), title: stateLabel, role: "img", "aria-label": stateLabel }),
          h("div", {}, h("span", { class: "name", text: p.id }), bits.length ? h("span", { class: "prov", text: bits.join(" · ") }) : null),
          h("div", { class: "state", text: stateLabel }),
          err ? h("div", { class: "err", text: err }) : null);
      })));
}

/** Le contenu d'une rubrique, ajouté à `nodes`. embedded : dans la page d'un élément (ex. la Veille sous sa tâche). */
export function pageNodes(page: string, nodes: Child[], { embedded = false }: { embedded?: boolean } = {}): void {
  const sec = sectionById(page);
  const sets = S.settings.list.filter((s) => pageOf(s.section) === page && matches(s.label, s.description, s.key, s.group, ...(s.options ?? []).map((o) => o.label)));
  const provs = S.items.providers.filter((p) => pageOf(p.section) === page);
  const roles = slotsOn(page).length > 0;
  // Réglages rattachés à un élément (ex. Orca) : montrés dans l'élément (« Configurer »), pas dans la liste.
  // Les slots (slot.*) se règlent avec « Activer » sur les éléments, et l'interrupteur de mode.
  const owned = new Set(S.items.providers.flatMap((p) => p.items.flatMap((it) => it.settings ?? [])));
  const rest = sets.filter((s) => !s.key.startsWith("slot.") && !owned.has(s.key));

  if (roles && !S.query) {
    slotPage(page, nodes, rest, embedded);
    if (sec?.view === "plugins") nodes.push(pluginsBlock());
    return;
  }
  const provNodes: Child[] = [];
  const gridNodes: Child[] = [];
  // Rubrique « merge » (corps, connecteurs…) : UNE liste pour la rubrique, quel que soit le plugin qui fournit l'élément
  // (son nom devient une étiquette). Un plugin sans élément n'affiche rien : on l'ajoute avec le bouton « Ajouter ».
  const merged = !!sec?.merge;
  const lists = provs.filter((p) => p.layout !== "grid");
  if (merged) {
    const list = lists.flatMap((p) => visibleItems(p).map((it): [ItemProvider, ProviderItem] => [p, it]));
    if (list.length || !S.query) {
      // Le nom du plugin sert d'étiquette de type, sauf s'il n'y en a qu'un seul. Pas de titre : la page a déjà le sien.
      const many = new Set(list.map(([pp]) => pp.id)).size > 1;
      provNodes.push(h("section", { class: "prov", "aria-label": secLabel(page), "data-tab": secLabel(page) },
        list.length ? rowList(list.map(([p, it]): RowEntry => [p, it, many ? tr(p.label) : ""])) : h("div", { class: "empty-line", text: t("noItems") })));
    }
  }
  for (const p of provs) {
    if (p.layout === "grid") {
      const g = avatarGrid(p);
      if (g) gridNodes.push(h("div", { class: "block", "data-tab": tr(p.label) }, h("h3", {}, tr(p.label), p.description ? h("small", { text: tr(p.description) }) : null), g));
    } else if (!merged) { const c = providerCard(p); if (c) provNodes.push(c); }
  }
  const provBlock = () => {
    if (!provNodes.length && !(lists.length && !S.query)) return;
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
