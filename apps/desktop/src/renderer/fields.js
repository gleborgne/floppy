// Champs des formulaires déclarés par les plugins (texte, secret, liste, chemin, enregistrement…) : l'éditeur
// (ajouter un élément) et le formulaire en place les dessinent. La fenêtre donne ce qui lui appartient (configureFields).
import { h, nextId } from "./dom.js";
import { audioField } from "./voice-recorder.js";
import { goneOption, listAdd } from "./form-rules.js";

/** Valeur montrée pour un secret déjà rangé dans le coffre (le noyau ne le renvoie jamais). */
export const SECRET_SET = "__secret_set__";

/** Ce que la fenêtre donne aux champs : textes, pont vers l'app, états des enregistreurs, redessins. */
let d = null;
export function configureFields(deps) { d = deps; }
const t = (k) => d.t(k);
const tr = (x) => d.tr(x);

export const visible = (f, values) => !f.showIf || (f.showIf.values ?? []).some((v) => String(v) === String(values[f.showIf.key]));

/**
 * Le contrôle d'un champ déclaré. values : les valeurs du formulaire (modifiées en place). Chaque changement « fini »
 * (champ quitté, Entrée, case cochée, pastille ajoutée ou retirée) émet un événement « change » qui remonte : le
 * formulaire en place l'enregistre.
 */
export function fieldControl(f, values, onChange, opts = {}) {
  const id = nextId();
  const v = values[f.key];
  const set = (x) => { values[f.key] = x; onChange(); };
  let ctl;
  switch (f.type) {
    case "audio": {
      // L'état de l'enregistreur survit aux dessins de la page (un enregistrement peut être en cours).
      const sk = `${opts.stateKey ?? "ed"}/${f.key}`;
      const st = d.audioStates.get(sk) ?? {};
      d.audioStates.set(sk, st);
      const box = audioField({
        f, st, value: v, set,
        // La phrase lue remplit le champ texte, sauf si l'utilisateur y a écrit autre chose.
        setText: (text, prompts) => { if (f.textKey && (!values[f.textKey] || prompts.includes(values[f.textKey]))) values[f.textKey] = text; },
        deps: {
          h, t, tr, icon: window.lucideIcon,
          // Fin d'un enregistrement : le formulaire en place l'enregistre tout de suite, puis on redessine.
          // (Pas d'événement « change » : la case a pu être redessinée pendant l'enregistrement.)
          redraw: () => { if (st.phase === "done" && st.committed !== st.url) { st.committed = st.url; opts.commit?.(); } if (opts.stateKey) d.render(); else d.drawEditor(); },
          ...(opts.listen ? { listenCurrent: opts.listen } : {}),
        },
      });
      box.id = id;
      return { id, ctl: box, wide: true };
    }
    case "boolean": {
      ctl = h("input", { type: "checkbox", id, checked: v === true });
      ctl.addEventListener("change", () => set(ctl.checked));
      return { id, ctl, inline: true };
    }
    case "number": {
      ctl = h("input", { type: "number", id, min: f.min, max: f.max, step: "any" });
      ctl.value = v === undefined || v === null ? "" : String(v);
      ctl.addEventListener("input", () => set(ctl.value === "" ? undefined : Number(ctl.value)));
      break;
    }
    case "select": {
      ctl = h("select", { id });
      // Valeur gardée qui n'est plus proposée (ex. un modèle qui ne sait plus faire l'affaire) : montrée telle quelle,
      // marquée, plutôt qu'une liste vide qui laisse croire que rien n'est choisi.
      const gone = goneOption(f.options, v);
      if (gone) ctl.append(h("option", { value: String(v), text: `${gone} (${t("optGone")})` }));
      for (const o of f.options ?? []) ctl.append(h("option", { value: o.value, text: tr(o.label) }));
      if (v === undefined && f.options?.length) values[f.key] = f.options[0].value;
      ctl.value = String(values[f.key] ?? "");
      ctl.addEventListener("change", () => set(ctl.value));
      break;
    }
    case "secret": {
      const was = v === SECRET_SET;
      ctl = h("input", { type: "password", id, autocomplete: "new-password", placeholder: was ? t("saved") : tr(f.placeholder) });
      ctl.addEventListener("input", () => set(ctl.value || (was ? SECRET_SET : "")));
      break;
    }
    case "path": {
      const input = h("input", { type: "text", id, placeholder: tr(f.placeholder) });
      input.value = v ?? "";
      input.addEventListener("input", () => set(input.value));
      const pick = h("button", { type: "button", class: "btn small", text: t("pick"), disabled: !d.api?.pickPath, onclick: async () => {
        const p = await d.api.pickPath({ directory: !!f.directory, filters: f.filters ?? [] });
        if (p) { input.value = p; set(p); input.dispatchEvent(new Event("change", { bubbles: true })); }
      } });
      ctl = h("div", { class: "pathrow" }, input, pick);
      ctl.labelTarget = input;
      break;
    }
    case "list": {
      // Pastilles : × retire, Entrée (ou virgule) ajoute ; un collage de plusieurs lignes donne plusieurs pastilles.
      const input = h("input", { type: "text", id, placeholder: tr(f.placeholder) || t("listAddHint") });
      const box = h("div", { class: "lchips", role: "group", onclick: (e) => { if (e.target === box) input.focus(); } }, input);
      const now = () => (Array.isArray(values[f.key]) ? values[f.key] : []);
      const changed = () => box.dispatchEvent(new Event("change", { bubbles: true }));
      const draw = () => {
        for (const n of box.querySelectorAll(".lchip")) n.remove();
        for (const x of now()) box.insertBefore(h("span", { class: "lchip" }, h("span", { text: x }),
          h("button", { type: "button", "aria-label": `${t("removeWord")} ${x}`, onclick: () => { set(now().filter((y) => y !== x)); draw(); input.focus(); changed(); } }, "×")), input);
      };
      const take = (text) => {
        const next = listAdd(now(), text);
        input.value = "";
        if (next.length === now().length) return;
        set(next); draw(); changed();
      };
      input.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); take(input.value); } });
      input.addEventListener("paste", (e) => { const text = e.clipboardData?.getData("text") ?? ""; if (/[\n,;]/.test(text)) { e.preventDefault(); take(text); } });
      // Texte tapé puis champ quitté : il compte aussi (rien ne se perd). Son propre « change » ne remonte pas.
      input.addEventListener("change", (e) => { e.stopPropagation(); if (input.value.trim()) take(input.value); });
      draw();
      ctl = box;
      ctl.labelTarget = input;
      break;
    }
    case "textarea": {
      ctl = h("textarea", { id, placeholder: tr(f.placeholder) });
      ctl.value = v ?? "";
      ctl.addEventListener("input", () => set(ctl.value));
      break;
    }
    case "keyvalue": {
      const rows = Object.entries(v && typeof v === "object" ? v : {});
      const box = h("div", { class: "kv", id, role: "group" });
      const sync = () => {
        const o = {};
        for (const r of box.querySelectorAll(".r")) { const [k, val] = r.querySelectorAll("input"); if (k.value.trim()) o[k.value.trim()] = val.value; }
        set(o);
      };
      const addRow = (k = "", val = "") => {
        const ki = h("input", { type: "text", "aria-label": t("key"), placeholder: t("key") });
        const vi = h("input", { type: "text", "aria-label": t("value"), placeholder: t("value") });
        ki.value = k; vi.value = val;
        ki.addEventListener("input", sync); vi.addEventListener("input", sync);
        const del = h("button", { type: "button", class: "btn small", "aria-label": t("remove"), text: "×", onclick: () => { r.remove(); sync(); box.dispatchEvent(new Event("change", { bubbles: true })); } });
        const r = h("div", { class: "r" }, ki, vi, del);
        box.insertBefore(r, add);
      };
      const add = h("button", { type: "button", class: "btn small", text: t("addRow"), onclick: () => addRow() });
      box.append(add);
      for (const [k, val] of rows) addRow(k, String(val));
      ctl = box;
      break;
    }
    default: {
      ctl = h("input", { type: "text", id, placeholder: tr(f.placeholder) });
      ctl.value = v ?? "";
      ctl.addEventListener("input", () => set(ctl.value));
    }
  }
  return { id, ctl };
}

/** opts.stateKey : formulaire en place d'un élément (« fournisseur/élément ») ; opts.listen : écouter l'enregistrement gardé. */
export function formNode(kind, values, opts = {}) {
  const form = h("div", { class: "form" });
  const adv = h("div", { class: "form" });
  const wraps = [];
  const refresh = () => { for (const [f, w] of wraps) w.hidden = !visible(f, values); };
  for (const f of kind.fields) {
    const { id, ctl, inline, wide: wideCtl } = fieldControl(f, values, refresh, opts);
    // Un enregistreur n'est pas un champ de saisie : son nom est un titre de groupe, pas une étiquette « for ».
    const lab = f.type === "audio"
      ? h("span", { class: "flabel", id: `${id}-l` }, tr(f.label), f.required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null)
      : h("label", { for: ctl.labelTarget ? ctl.labelTarget.id : id }, tr(f.label), f.required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null);
    if (f.type === "audio") ctl.setAttribute("aria-labelledby", `${id}-l`);
    if (f.required) (ctl.labelTarget ?? ctl).setAttribute("aria-required", "true");
    const hint = f.hint ? h("span", { class: "hint", text: tr(f.hint) }) : null;
    const wide = wideCtl || f.type === "textarea" || f.type === "list" || f.type === "keyvalue";
    const w = inline ? h("div", { class: "field check" }, ctl, lab, hint) : h("div", { class: wide ? "field wide" : "field" }, lab, ctl, hint);
    wraps.push([f, w]);
    (f.advanced ? adv : form).append(w);
  }
  refresh();
  if (adv.childElementCount) form.append(h("details", { class: "adv" }, h("summary", { text: t("advanced") }), adv));
  return form;
}
