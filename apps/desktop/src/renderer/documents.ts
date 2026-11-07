// Fenêtre « Documents » : liste à gauche, document à droite. Le HTML du document vient du processus principal
// (Markdown déjà rendu et nettoyé) ; ici on ne fait que le placer, et envoyer les clics.
// Supprimer : icône poubelle sur chaque ligne (au survol ou au clavier) ; 1er clic = « Supprimer ? », 2e clic = supprimé.
// Éléments de la page : ils existent dans documents.html (pas de repli).
const $ = (id: string) => document.getElementById(id) as HTMLElement;
type Lang = "fr" | "en";
const TXT: Record<Lang, Record<string, string>> = {
  fr: {
    title: "Documents", filter: "Filtre", all: "Tous", veille: "Veille", none: "Aucun document dans ce filtre.", empty: "Aucun document pour l'instant.",
    del: "Supprimer", delSure: "Supprimer ?", delTip: "Supprimer ce document", delSureTip: "Cliquer encore pour supprimer (le fichier est effacé)",
  },
  en: {
    title: "Documents", filter: "Filter", all: "All", veille: "News", none: "No document in this filter.", empty: "No document yet.",
    del: "Delete", delSure: "Delete?", delTip: "Delete this document", delSureTip: "Click again to delete (the file is erased)",
  },
};
let lang: Lang = "fr";
let current = "";
let liste: DocEntry[] = [];
let filtre = "";
/** Document en attente de confirmation (2e clic), et son minuteur. */
let arming = "";
let armTimer = 0;
const t = (k: string): string => (TXT[lang] ?? TXT.fr)[k] ?? k;

function dateText(iso: string | undefined): string {
  const d = new Date(iso ?? NaN);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang === "en" ? "en-GB" : "fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function disarm() { arming = ""; clearTimeout(armTimer); }

/** Bouton poubelle d'une ligne : 1er clic arme (rouge, « Supprimer ? »), 2e clic supprime ; sans 2e clic en 4 s : annulé. */
function deleteButton(d: DocEntry): HTMLButtonElement {
  const armed = arming === d.id;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "del" + (armed ? " armed" : "");
  b.title = armed ? t("delSureTip") : t("delTip");
  b.setAttribute("aria-label", `${armed ? t("delSure") : t("del")} : ${d.titre}`);
  const icon = window.lucideIcon?.("trash-2");
  if (icon) b.append(icon);
  if (armed) { const s = document.createElement("span"); s.textContent = t("delSure"); b.append(s); }
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (arming !== d.id) {
      disarm();
      arming = d.id;
      armTimer = setTimeout(() => { disarm(); renderList(); }, 4000);
      renderList();
      focusDel(d.id);
      return;
    }
    disarm();
    window.floppyDocs.remove(d.id, current);
    // Retiré tout de suite de la liste ; la vraie liste revient du noyau.
    liste = liste.filter((x) => x.id !== d.id);
    renderList();
  });
  b.addEventListener("blur", () => { if (arming === d.id) setTimeout(() => { if (arming === d.id && !document.activeElement?.closest?.(".row.armed")) { disarm(); renderList(); } }, 150); });
  return b;
}

function focusDel(id: string): void {
  requestAnimationFrame(() => { for (const r of document.querySelectorAll<HTMLElement>(".row")) if (r.dataset.id === id) r.querySelector<HTMLElement>(".del")?.focus(); });
}

function renderList() {
  const hasVeille = liste.some((d) => d.tags.includes("veille"));
  const box = $("filters");
  box.replaceChildren();
  box.hidden = !hasVeille;
  if (hasVeille) {
    for (const [value, label] of [["", t("all")], ["veille", t("veille")]] as [string, string][]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (filtre === value ? " on" : "");
      b.textContent = label;
      b.setAttribute("aria-pressed", String(filtre === value));
      b.addEventListener("click", () => { filtre = value; renderList(); });
      box.append(b);
    }
  } else filtre = "";
  const nav = $("list");
  nav.replaceChildren();
  const shown = liste.filter((d) => !filtre || d.tags.includes(filtre));
  if (!shown.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = liste.length ? t("none") : t("empty"); nav.append(p); return; }
  for (const d of shown) {
    const row = document.createElement("div");
    row.className = "row" + (d.id === current ? " on" : "") + (arming === d.id ? " armed" : "");
    row.dataset.id = d.id;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    if (d.id === current) b.setAttribute("aria-current", "true");
    const a = document.createElement("span"); a.className = "t"; a.textContent = d.titre;
    const c = document.createElement("span"); c.className = "d"; c.textContent = dateText(d.date);
    b.append(a, c);
    b.addEventListener("click", () => { if (d.id !== current) window.floppyDocs.select(d.id); });
    // Touche Suppr sur une ligne : comme la poubelle (2 appuis).
    b.addEventListener("keydown", (e) => { if (e.key === "Delete") { e.preventDefault(); row.querySelector<HTMLElement>(".del")?.click(); } });
    row.append(b, deleteButton(d));
    nav.append(row);
  }
}

/** Textes fixes de la page, dans la langue de l'interface. */
function applyTexts() {
  document.documentElement.lang = lang;
  $("side-title").textContent = t("title");
  $("filters").setAttribute("aria-label", t("filter"));
  $("list").setAttribute("aria-label", t("title"));
}

let shown: DocsShow | null = null; // dernier document reçu (pour le réafficher dans une autre langue)
function showDoc(p: DocsShow): void {
  shown = p;
  current = String(p.id ?? "");
  $("titre").textContent = String(p.titre ?? "");
  $("date").textContent = dateText(liste.find((d) => d.id === current)?.date);
  document.title = `Floppy — ${p.titre || t("title")}`;
  const html = String(p.html ?? "");
  if (current && html) $("doc").innerHTML = html;
  else { const e = document.createElement("p"); e.className = "empty"; e.textContent = t("empty"); $("doc").replaceChildren(e); }
  $("main").scrollTop = 0;
}

window.floppyDocs.onShow((p) => {
  if (p.lang === "fr" || p.lang === "en") lang = p.lang;
  if (Array.isArray(p.liste)) liste = p.liste;
  applyTexts();
  disarm();
  showDoc(p);
  renderList();
});

// Langue de l'interface changée : textes fixes, dates et liste refaits ; le document reste à sa place.
window.floppyDocs.onLang?.((l) => {
  if ((l !== "fr" && l !== "en") || l === lang) return;
  lang = l;
  applyTexts();
  if (shown) {
    const scroll = $("main").scrollTop;
    showDoc(shown);
    $("main").scrollTop = scroll;
  }
  renderList();
});

// Nouvelle liste après une suppression : le document affiché reste.
window.floppyDocs.onList((l) => {
  if (!Array.isArray(l)) return;
  liste = l;
  renderList();
});

// Les liens ne naviguent jamais dans la fenêtre : le processus principal vérifie et ouvre le navigateur.
document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a) return;
  e.preventDefault();
  window.floppyDocs.link(a.getAttribute("href") ?? "");
});

// Module (pas de nom global partagé entre les pages).
export {};
