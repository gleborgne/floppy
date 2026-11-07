// Champs des formulaires déclarés par les plugins (texte, secret, liste, chemin, enregistrement…) : l'éditeur
// (ajouter un élément) et le formulaire en place les dessinent. La fenêtre donne ce qui lui appartient (configureFields).
//
// Chaque champ est décrit depuis `values` (les valeurs du formulaire, gardées par la fenêtre entre deux dessins) :
// une frappe écrit dans `values`, puis `redraw` redessine (un champ montré ou caché selon un autre, showIf). Preact ne
// touche pas un champ dont la valeur affichée est déjà la bonne : le curseur reste où il est.
import { h, hdom, island, nextId } from "./dom.ts";
import type { Ev, FormTarget } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { audioField } from "./voice-recorder.ts";
import type { AudioState } from "./voice-recorder.ts";
import { goneOption, listAdd } from "./form-rules.ts";

/** Valeur montrée pour un secret déjà rangé dans le coffre (le noyau ne le renvoie jamais). */
export const SECRET_SET = "__secret_set__";

/** Ce que la fenêtre donne aux champs : textes, pont vers l'app, états des enregistreurs, redessins. */
/** État d'un enregistreur, avec la dernière adresse déjà enregistrée par le formulaire en place. */
export type FieldAudioState = AudioState & { committed?: string };
export interface FieldDeps {
  t: (k: string) => string;
  tr: (x: unknown) => string;
  api: FloppySettingsApi | undefined;
  audioStates: Map<string, FieldAudioState>;
  render: () => void;
  drawEditor: () => void;
}
let d: FieldDeps | null = null;
export function configureFields(deps: FieldDeps): void { d = deps; }
/** Les dépendances données par la fenêtre au démarrage (avant tout dessin). */
const deps = (): FieldDeps => d as FieldDeps;
const t = (k: string): string => deps().t(k);
const tr = (x: unknown): string => deps().tr(x);

/** Lignes d'un champ « clé = valeur » en cours d'édition (une ligne vide compte, elle n'est pas encore dans values). */
/** Une ligne « clé = valeur » d'un champ keyvalue. */
interface KvRow { k: string; v: string; id: string }
const kvRows = new Map<string, KvRow[]>();
/** Oublie l'état des champs d'un formulaire (« ed » : la fenêtre d'ajout, rouverte à neuf). */
export function resetFieldState(prefix: string): void { for (const k of kvRows.keys()) if (k.startsWith(`${prefix}/`)) kvRows.delete(k); }

export const visible = (f: FormField, values: Record<string, unknown>): boolean => {
  const cond = f.showIf;
  return !cond || (cond.values ?? []).some((v) => String(v) === String(values[cond.key]));
};

/**
 * Le contrôle d'un champ déclaré. values : les valeurs du formulaire (modifiées en place). opts.redraw : redessine après
 * une frappe ; opts.commit : un changement « fini » qui n'émet pas d'événement « change » natif (pastille ajoutée ou
 * retirée, ligne supprimée, chemin choisi) ; le formulaire en place l'enregistre. Les autres (champ quitté, case cochée,
 * choix dans une liste) remontent en « change » natif jusqu'au formulaire.
 */
/** Options des champs et du formulaire (voir fieldControl et formNode). */
export interface FieldOpts {
  stateKey?: string; redraw?: () => void; commit?: () => void; listen?: () => unknown; onchange?: (e: Ev) => unknown;
}
/** Un champ dessiné : son id, son contrôle, et sa forme (case à cocher en ligne, champ large). */
export interface FieldControl { id: string; ctl: VNode; inline?: boolean; wide?: boolean }

export function fieldControl(f: FormField, values: Record<string, unknown>, opts: FieldOpts = {}): FieldControl {
  const id = nextId();
  const v = values[f.key];
  const sk = `${opts.stateKey ?? "ed"}/${f.key}`;
  const redraw = () => opts.redraw?.();
  const set = (x: unknown) => { values[f.key] = x; redraw(); };
  const done = () => opts.commit?.();
  const req = f.required ? { "aria-required": "true" } : {};
  switch (f.type) {
    case "audio": {
      // L'état de l'enregistreur survit aux dessins de la page (un enregistrement peut être en cours).
      const st: FieldAudioState = deps().audioStates.get(sk) ?? {};
      deps().audioStates.set(sk, st);
      // Construit à la main (micro, minuterie, ondes) : posé tel quel dans la page, refait à chaque dessin.
      const make = () => {
        const box = audioField({
          f, st, value: values[f.key], set: (x: string) => { values[f.key] = x; },
          // La phrase lue remplit le champ texte, sauf si l'utilisateur y a écrit autre chose.
          setText: (text: string, prompts: string[]) => { if (f.textKey && (!values[f.textKey] || prompts.includes(values[f.textKey] as string))) values[f.textKey] = text; },
          deps: {
            h: hdom, t, tr, icon: window.lucideIcon ?? (() => document.createElement("span")),
            // Fin d'un enregistrement : le formulaire en place l'enregistre tout de suite, puis on redessine.
            redraw: () => { if (st.phase === "done" && st.committed !== st.url) { st.committed = st.url; done(); } redraw(); },
            ...(opts.listen ? { listenCurrent: opts.listen } : {}),
          },
        });
        box.id = id;
        box.setAttribute("aria-labelledby", `${id}-l`);
        return box;
      };
      return { id, ctl: island(make), wide: true };
    }
    case "boolean":
      return { id, inline: true, ctl: h("input", { type: "checkbox", id, checked: v === true, ...req, onchange: (e: Ev) => set(e.currentTarget.checked) }) };
    case "number":
      return { id, ctl: h("input", { type: "number", id, min: f.min, max: f.max, step: "any", value: v === undefined || v === null ? "" : String(v), ...req,
        oninput: (e: Ev) => set(e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value)) }) };
    case "select": {
      // Valeur gardée qui n'est plus proposée (ex. un modèle qui ne sait plus faire l'affaire) : montrée telle quelle,
      // marquée, plutôt qu'une liste vide qui laisse croire que rien n'est choisi.
      const gone = goneOption(f.options, v);
      if (v === undefined && f.options?.length) values[f.key] = f.options[0]?.value;
      return { id, ctl: h("select", { id, value: String(values[f.key] ?? ""), ...req, onchange: (e: Ev) => set(e.currentTarget.value) },
        gone ? h("option", { value: String(v), text: `${gone} (${t("optGone")})` }) : null,
        (f.options ?? []).map((o) => h("option", { value: o.value, text: tr(o.label) }))) };
    }
    case "secret": {
      // Jamais réaffiché : le champ reste vide (placeholder « enregistré ») tant qu'on n'y tape rien.
      const was = v === SECRET_SET;
      return { id, ctl: h("input", { type: "password", id, autocomplete: "new-password", placeholder: was ? t("saved") : tr(f.placeholder), ...req,
        oninput: (e: Ev) => { values[f.key] = e.currentTarget.value || (was ? SECRET_SET : ""); } }) };
    }
    case "path": {
      const input = h("input", { type: "text", id, placeholder: tr(f.placeholder), value: String(v ?? ""), ...req, oninput: (e: Ev) => set(e.currentTarget.value) });
      const pick = h("button", { type: "button", class: "btn small", text: t("pick"), disabled: !deps().api?.pickPath, onclick: async () => {
        const p = await deps().api?.pickPath({ directory: !!f.directory, filters: f.filters ?? [] });
        if (p) { set(p); done(); }
      } });
      return { id, ctl: h("div", { class: "pathrow" }, input, pick) };
    }
    case "list": {
      // Pastilles : × retire, Entrée (ou virgule) ajoute ; un collage de plusieurs lignes donne plusieurs pastilles.
      const now = (): string[] => (Array.isArray(values[f.key]) ? (values[f.key] as string[]) : []);
      const take = (input: FormTarget, text: string) => {
        const next = listAdd(now(), text);
        input.value = "";
        if (next.length === now().length) return;
        set(next); done();
      };
      const input = h("input", {
        type: "text", id, placeholder: tr(f.placeholder) || t("listAddHint"), ...req,
        onkeydown: (e: Ev<KeyboardEvent>) => { const el = e.currentTarget; if ((e.key === "Enter" || e.key === ",") && el.value.trim()) { e.preventDefault(); take(el, el.value); } },
        onpaste: (e: Ev<ClipboardEvent>) => { const text = e.clipboardData?.getData("text") ?? ""; if (/[\n,;]/.test(text)) { e.preventDefault(); take(e.currentTarget, text); } },
        // Texte tapé puis champ quitté : il compte aussi (rien ne se perd). Son propre « change » ne remonte pas.
        onchange: (e: Ev) => { e.stopPropagation(); if (e.currentTarget.value.trim()) take(e.currentTarget, e.currentTarget.value); },
      });
      const chips = now().map((x) => h("span", { class: "lchip", key: x }, h("span", { text: x }),
        h("button", { type: "button", "aria-label": `${t("removeWord")} ${x}`, onclick: (e: Ev<MouseEvent>) => {
          const box = e.currentTarget.closest(".lchips");
          set(now().filter((y) => y !== x)); done();
          box?.querySelector("input")?.focus();
        } }, "×")));
      return { id, ctl: h("div", { class: "lchips", role: "group", onclick: (e: Ev<MouseEvent>) => { if (e.target === e.currentTarget) e.currentTarget.querySelector("input")?.focus(); } }, chips, input) };
    }
    case "textarea":
      return { id, ctl: h("textarea", { id, placeholder: tr(f.placeholder), value: String(v ?? ""), ...req, oninput: (e: Ev) => set(e.currentTarget.value) }) };
    case "keyvalue": {
      if (!kvRows.has(sk)) kvRows.set(sk, Object.entries(v && typeof v === "object" ? v : {}).map(([k, val]) => ({ k, v: String(val), id: nextId() })));
      const rows = kvRows.get(sk) ?? [];
      const sync = () => {
        const o: Record<string, string> = {};
        for (const r of rows) if (r.k.trim()) o[r.k.trim()] = r.v;
        values[f.key] = o;
      };
      return { id, ctl: h("div", { class: "kv", id, role: "group" },
        rows.map((r) => h("div", { class: "r", key: r.id },
          h("input", { type: "text", "aria-label": t("key"), placeholder: t("key"), value: r.k, oninput: (e: Ev) => { r.k = e.currentTarget.value; sync(); } }),
          h("input", { type: "text", "aria-label": t("value"), placeholder: t("value"), value: r.v, oninput: (e: Ev) => { r.v = e.currentTarget.value; sync(); } }),
          h("button", { type: "button", class: "btn small", "aria-label": t("remove"), text: "×", onclick: () => { rows.splice(rows.indexOf(r), 1); sync(); redraw(); done(); } }))),
        h("button", { type: "button", class: "btn small", text: t("addRow"), onclick: () => { rows.push({ k: "", v: "", id: nextId() }); redraw(); } })) };
    }
    default:
      return { id, ctl: h("input", { type: "text", id, placeholder: tr(f.placeholder), value: String(v ?? ""), ...req, oninput: (e: Ev) => set(e.currentTarget.value) }) };
  }
}

/**
 * Le formulaire d'un type d'élément. opts.stateKey : formulaire en place d'un élément (« fournisseur/élément ») ;
 * opts.redraw : redessine (champs montrés selon d'autres) ; opts.commit : changement fini sans « change » natif ;
 * opts.listen : écouter l'enregistrement gardé ; opts.onchange : un « change » natif qui remonte d'un champ.
 */
export function formNode(kind: ItemKind, values: Record<string, unknown>, opts: FieldOpts = {}): VNode {
  const main: VNode[] = [];
  const adv: VNode[] = [];
  for (const f of kind.fields) {
    const { id, ctl, inline, wide: wideCtl } = fieldControl(f, values, opts);
    const req = f.required ? h("span", { class: "req", "aria-hidden": "true", text: " *" }) : null;
    // Un enregistreur n'est pas un champ de saisie : son nom est un titre de groupe, pas une étiquette « for ».
    const lab = f.type === "audio"
      ? h("span", { class: "flabel", id: `${id}-l` }, tr(f.label), req)
      : h("label", { for: id }, tr(f.label), req);
    const hint = f.hint ? h("span", { class: "hint", text: tr(f.hint) }) : null;
    const wide = wideCtl || f.type === "textarea" || f.type === "list" || f.type === "keyvalue";
    const hidden = !visible(f, values);
    const w = inline
      ? h("div", { class: "field check", hidden, key: f.key }, ctl, lab, hint)
      : h("div", { class: wide ? "field wide" : "field", hidden, key: f.key }, lab, ctl, hint);
    (f.advanced ? adv : main).push(w);
  }
  return h("div", { class: "form", ...(opts.onchange ? { onchange: opts.onchange } : {}) },
    main,
    adv.length ? h("details", { class: "adv" }, h("summary", { text: t("advanced") }), h("div", { class: "form" }, adv)) : null);
}
