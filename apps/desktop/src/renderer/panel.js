// Fenêtre de résultats : rendu d'une surface A2UI (v0.8, sous-ensemble).
// Composants : Column, Row, List, Card, Text (usageHint h1..h5, body, caption), Button, Divider, Image.
// Texte toujours en textContent (jamais de HTML venu du noyau ou du web). Images : https seulement.
// Un bouton envoie son action (nom + contexte) au processus principal, qui décide (ex. ouvrir_url → http(s)).
const $ = (id) => document.getElementById(id);

function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "literalString" in v) return String(v.literalString ?? "");
  return "";
}

function render(messages) {
  const comps = new Map();
  let root = null;
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const c of m?.surfaceUpdate?.components ?? []) if (c?.id) comps.set(c.id, c.component ?? {});
    if (m?.beginRendering?.root) root = m.beginRendering.root;
  }
  const seen = new Set();
  const build = (id) => {
    if (!id || seen.has(id) || seen.size > 2000) return null;
    seen.add(id);
    const c = comps.get(id);
    if (!c) return null;
    const [type, p] = Object.entries(c)[0] ?? [];
    const kids = (list) => (list?.explicitList ?? []).map(build).filter(Boolean);
    switch (type) {
      case "Column": case "List": { const d = document.createElement("div"); d.className = "col"; d.append(...kids(p.children)); return d; }
      case "Row": { const d = document.createElement("div"); d.className = "row"; d.append(...kids(p.children)); return d; }
      case "Card": { const d = document.createElement("section"); d.className = "card"; const k = build(p.child); if (k) d.append(k); return d; }
      case "Text": {
        const hint = String(p.usageHint ?? "body");
        const tag = /^h[1-5]$/.test(hint) ? hint : "p";
        const e = document.createElement(tag);
        e.className = /^h[1-5]$/.test(hint) ? hint : hint === "caption" ? "caption" : "body";
        e.textContent = str(p.text);
        return e;
      }
      case "Divider": return document.createElement("hr");
      case "Image": {
        const url = str(p.url);
        if (!/^https:\/\//i.test(url)) return null;
        const img = document.createElement("img"); img.src = url; img.alt = ""; return img;
      }
      case "Button": {
        const b = document.createElement("button");
        b.type = "button";
        if (p.primary) b.className = "primary";
        const label = build(p.child);
        b.textContent = label?.textContent ?? "OK";
        const ctx = {};
        for (const kv of p.action?.context ?? []) if (kv?.key) ctx[kv.key] = str(kv.value);
        b.addEventListener("click", () => window.floppyPanel.action(String(p.action?.name ?? ""), ctx));
        return b;
      }
      default: return null;
    }
  };
  const out = build(root);
  const surface = $("surface");
  surface.replaceChildren(...(out ? [out] : []));
  surface.querySelector("button")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.floppyPanel.onShow((data) => {
  document.title = data?.title ? `Floppy — ${data.title}` : "Floppy";
  if (data?.lang) document.documentElement.lang = data.lang;
  render(data?.a2ui);
});
