// Icônes Lucide (https://lucide.dev), copiées de lucide-static v1.59.0 — licence ISC, © Lucide Icons and Contributors.
// Construites en SVG par le DOM (pas de innerHTML) : couleur = currentColor, taille réglée en CSS.
// Pour en ajouter une : copier les <path> de node_modules/lucide-static/icons/<nom>.svg (même version) ici.
(() => {
  const ICONS = {
    "arrow-left": ["m12 19-7-7 7-7", "M19 12H5"],
    "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
    "check": ["M20 6 9 17l-5-5"],
    "download": ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5"],
    "chevron-right": ["m9 18 6-6-6-6"],
    "x": ["M18 6 6 18", "m6 6 12 12"],
    "trash-2": ["M10 11v6", "M14 11v6", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  };
  const NS = "http://www.w3.org/2000/svg";
  /** Une icône Lucide prête à placer dans un bouton (décorative : le bouton porte le nom). */
  window.lucideIcon = (name) => {
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: `icon lucide-${name}` })) svg.setAttribute(k, v);
    for (const d of ICONS[name] ?? []) { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.append(p); }
    return svg;
  };
})();
