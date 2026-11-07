// Petits outils d'affichage partagés par les modules de la fenêtre des réglages.
//
// La fenêtre décrit ce qu'elle montre avec h() (éléments virtuels de Preact) et le donne à mount() : Preact compare avec
// ce qui est à l'écran et ne change que ce qui diffère. Un bouton, un champ, une ligne restent les mêmes éléments d'un
// dessin à l'autre : un clic n'est jamais perdu, un champ garde son curseur, une animation d'entrée ne se rejoue pas.
// Tout texte venu du noyau passe en texte (jamais de HTML).
import { h as vh, render } from "./vendor/preact.mjs";

/** Ce qui n'est pas affiché parmi les enfants (comme avant : null, undefined, false). */
const shown = (c) => c !== undefined && c !== null && c !== false && c !== true;

/**
 * Élément virtuel : h("div", { class, text, onclick… }, enfants…). `text` : le texte, placé avant les enfants.
 * Une propriété null, undefined ou false est absente (un attribut retiré, un bouton qui n'est plus désactivé).
 */
export function h(tag, props, ...kids) {
  const p = {};
  let text = null;
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") text = String(v);
    else p[k] = v;
  }
  const children = kids.flat(Infinity).filter(shown);
  return vh(tag, p, ...(text === null ? children : [text, ...children]));
}

/** Dessine `vnode` dans `container` (Preact : seuls les changements touchent la page). */
export function mount(vnode, container) {
  render(vnode, container);
}

/** Icône Lucide (voir icons.js) en élément virtuel : décorative, le bouton porte le nom. */
export function icon(name) {
  const paths = typeof window !== "undefined" && window.lucideIconPaths ? window.lucideIconPaths(name) : [];
  return vh("svg", {
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false", class: `icon lucide-${name}`,
  }, ...paths.map((d) => vh("path", { d })));
}

/**
 * Un morceau construit à la main dans le DOM (l'enregistreur de voix : micro, minuterie, ondes) posé dans la page.
 * `make()` le construit à chaque dessin (son état vit à part) ; la boîte ne compte pas dans la mise en page.
 */
export function island(make) {
  return vh("div", { class: "island", ref: (el) => { if (el) el.replaceChildren(make()); } });
}

/** Élément réel du DOM (pour les morceaux construits à la main, voir island) : même forme que h(). */
export function hdom(tag, props, ...kids) {
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
  for (const c of kids.flat()) if (shown(c)) e.append(c);
  return e;
}

let uid = 0;
/** Id unique dans la page (lien label / champ). */
export const nextId = () => `f${++uid}`;
