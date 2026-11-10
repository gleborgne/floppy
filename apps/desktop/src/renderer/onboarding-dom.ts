// Fenêtre « Bienvenue » : petits outils d'affichage. Tout texte venu du noyau passe par textContent (jamais innerHTML) ;
// pas d'attribut style (la CSP le refuse) : des classes, ou le CSSOM (`el.style.transform = …`).

/** Enfant d'un élément : nœud, texte, ou rien (les tableaux sont aplatis). */
export type Kid = Node | string | null | undefined | false | Kid[];

/**
 * Élément DOM : attributs, texte (`text`), classe (`class`), écouteurs (`onclick`…) et `k`, une clé stable (`data-k`) qui
 * permet de rendre le focus à l'élément après un nouveau dessin de la page.
 */
export function h(tag: string, props?: Record<string, unknown> | null, ...kids: Kid[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (k === "k") e.setAttribute("data-k", String(v));
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(Infinity as 1) as (Node | string | null | undefined | false)[]) if (c !== undefined && c !== null && c !== false) e.append(c);
  return e;
}

const SVG = "http://www.w3.org/2000/svg";
/** Tracés (viewBox 24, trait de 2) des icônes de la fenêtre. */
const PATHS: Record<string, string[]> = {
  brain: ["M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5", "M9 18h6", "M10 22h4"],
  ears: ["M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0", "M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4"],
  voice: ["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"],
  tools: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  globe: ["M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20", "M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0"],
  check: ["M20 6 9 17l-5-5"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  mic: ["M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 2m-3 0a3 3 0 0 1 6 0v10a3 3 0 0 1-6 0z"],
  pen: ["M12 20h9", "M16.4 3.6a2 2 0 0 1 3 3L7 19l-4 1 1-4Z"],
  play: ["M6 3v18l14-9z"],
  stop: ["M6 6h12v12H6z"],
  mail: ["M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"],
  keyboard: ["M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", "M6 8h.01", "M10 8h.01", "M14 8h.01", "M18 8h.01", "M7 16h10", "M6 12h.01", "M18 12h.01", "M10 12h4"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  lock: ["M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M7 11V7a5 5 0 0 1 10 0v4"],
};

/** Icône décorative (le bouton ou la ligne porte le nom). Nom inconnu : une icône « outils ». */
export function icon(name: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "ic" })) svg.setAttribute(k, v);
  for (const d of PATHS[name] ?? PATHS.tools!) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/** Interrupteur (`role="switch"`) : cible de 44 px, piste et bouton dessinés en CSS. */
export function switchBtn(opts: { on: boolean; label: string; disabled?: boolean; k?: string; onToggle: () => void }): HTMLElement {
  return h("button", {
    type: "button", class: "sw", role: "switch", "aria-checked": String(opts.on), "aria-label": opts.label, disabled: opts.disabled, k: opts.k,
    onclick: opts.onToggle,
  }, h("span", { class: "sw-track" }, h("span", { class: "sw-knob" })));
}

/** Barre d'avancement (`role="progressbar"`) avec son libellé ; `value` de 0 à 1. */
export function progressBar(value: number, label: string): HTMLElement {
  const pct = Math.floor(Math.max(0, Math.min(1, value)) * 100);
  const fill = h("i");
  fill.style.transform = `scaleX(${pct / 100})`;
  return h("div", { class: "pbar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": label }, fill);
}
