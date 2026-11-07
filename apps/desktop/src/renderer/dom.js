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
