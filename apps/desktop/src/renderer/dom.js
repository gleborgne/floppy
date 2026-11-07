// Petits outils DOM partagés par les modules de la fenêtre des réglages.

/** Crée un élément : h("div", { class, text, onclick… }, enfants…). */
export function h(tag, props, ...kids) {
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
/** Id unique dans la page (lien label / champ). */
export const nextId = () => `f${++uid}`;

/* ---- Rendu sans clignotement : la page n'est reconstruite que si ce qu'elle montre change. */
// Ids donnés par nextId() (« f12 ») : nouveaux à chaque rendu, ils ne comptent pas dans la comparaison.
const ID_ATTRS = new Set(["id", "for", "aria-labelledby", "aria-describedby", "aria-controls"]);
const FIELD = /^(INPUT|SELECT|TEXTAREA)$/;

/** Empreinte de ce qu'un nœud montre : balise, attributs, valeur des champs, texte, enfants. */
export function fingerprint(n) {
  if (n.nodeType === 3) return JSON.stringify(n.data);
  if (n.nodeType !== 1) return "";
  const attrs = [...n.attributes].map((a) => `${a.name}=${ID_ATTRS.has(a.name) ? a.value.replace(/\bf\d+\b/g, "#") : a.value}`).sort().join(" ");
  const state = FIELD.test(n.tagName) ? ` value=${n.value ?? ""} checked=${!!n.checked}` : "";
  return `<${n.tagName} ${attrs}${state}>${[...n.childNodes].map(fingerprint).join("")}</>`;
}

/** Les enfants de `parent` montrent déjà exactement `nodes` : rien à reconstruire. */
export function sameContent(parent, nodes) {
  const cur = parent.childNodes;
  return cur.length === nodes.length && nodes.every((n, i) => fingerprint(n) === fingerprint(cur[i]));
}

/**
 * Remplace les enfants de `parent` par `nodes`, sauf s'ils montrent déjà la même chose. Une page identique n'est pas
 * reconstruite : pas de clignotement, et un clic en cours (appui puis relâchement) garde son bouton.
 * Rend true si la page a été reconstruite.
 */
export function replaceIfChanged(parent, nodes) {
  if (sameContent(parent, nodes)) return false;
  parent.replaceChildren(...nodes);
  return true;
}
