// Fenêtre des réglages : le formulaire en place d'un élément. Ses champs sont sur sa page et chaque changement fini
// s'enregistre seul (la fenêtre d'ajout ne sert qu'à ajouter).
import { h } from "./dom.ts";
import type { VNode } from "./vendor/preact.mjs";
import { formNode, visible } from "./fields.ts";
import { missingFields as missingOf } from "./form-rules.ts";
import { defaultsOf, itemOp, playAudio, quickOp, render, t, tr } from "./settings-state.ts";

/** « fournisseur/élément » -> { base, values } : les valeurs du formulaire, gardées d'un dessin à l'autre. */
const live = new Map<string, { base: string; values: Record<string, unknown> }>();
/** « fournisseur/élément » refusés : leurs valeurs restent celles tapées jusqu'au prochain enregistrement réussi. */
const drafts = new Set<string>();
/** « fournisseur/élément » -> { ok, busy, text, at } : dernier enregistrement, montré sur le formulaire. */
/** Dernier enregistrement d'un formulaire en place. */
interface SaveState { ok?: boolean; busy?: boolean; text?: string; at: number }
const saves = new Map<string, SaveState>();
/** « fournisseur/élément » -> résultat du dernier essai. */
const trials = new Map<string, { running?: boolean } & Partial<ItemOpResult>>();
let saveSeq = 0;

/**
 * Valeurs du formulaire d'un élément. Gardées entre deux dessins (ce qu'on tape ne disparaît pas quand Floppy envoie
 * des nouvelles) ; reprises de l'élément quand il a changé ailleurs (à la voix, après un enregistrement).
 */
function formValues(key: string, kind: ItemKind, it: ProviderItem): Record<string, unknown> {
  const base = JSON.stringify(it.values ?? {});
  let cur = live.get(key);
  if (!cur || (cur.base !== base && !drafts.has(key))) {
    cur = { base, values: { ...defaultsOf(kind), ...(it.values ?? {}) } };
    live.set(key, cur);
  }
  return cur.values;
}

/** Le son d'un essai (ex. la voix qui dit la phrase d'essai) : un lecteur pour le réécouter. */
export function trialPlayer(src: string): VNode {
  return h("audio", { class: "vtrial", controls: true, src, "aria-label": t("trialAudio") });
}

/** Le formulaire en place d'un élément, ou null s'il n'a rien à régler. */
export function inlineForm(p: ItemProvider, it: ProviderItem): VNode | null {
  const kind = p.kinds.find((x) => x.id === it.kind);
  if (!kind || !p.can.update || it.editable === false || !kind.fields.length) return null;
  const key = `${p.id}/${it.id}`;
  const values = formValues(key, kind, it);
  const last = saves.get(key);
  const fresh = last?.ok && Date.now() - last.at < 2500;
  const play = (it.actions ?? []).find((a) => a.play);
  const save = async () => {
    const miss = missingOf(kind.fields, values, visible);
    if (miss.length) {
      drafts.add(key);
      saves.set(key, { ok: false, text: `${t("required")} : ${miss.map((f) => tr(f.label)).join(", ")}`, at: Date.now() });
      render();
      return;
    }
    const n = ++saveSeq;
    saves.set(key, { busy: true, at: Date.now() });
    render();
    const r = await itemOp({ op: "update", provider: p.id, id: it.id, values: { ...values } });
    if (n !== saveSeq) return; // un enregistrement plus récent est parti entre-temps
    if (r.ok) {
      drafts.delete(key);
      saves.set(key, { ok: true, at: Date.now() });
      setTimeout(render, 2600); // « ✓ Enregistré » s'efface
    } else {
      drafts.add(key);
      saves.set(key, { ok: false, text: tr(r.text) || t("refused"), at: Date.now() });
    }
    render();
  };
  const form = formNode(kind, values, {
    stateKey: key, redraw: render, commit: () => { void save(); }, onchange: () => { void save(); },
    ...(play ? { listen: () => quickOp({ op: "action", provider: p.id, id: it.id, action: play.id }) } : {}),
  });
  const failed = last && !last.ok && !last.busy;
  const tri = trials.get(key);
  return h("div", { class: "scard iform" },
    h("div", { class: "fhead" }, h("span", { class: `fsaved${fresh ? " ok" : ""}`, role: "status", text: last?.busy ? t("saving") : fresh ? `✓ ${t("savedOk")}` : "" })),
    form,
    h("p", { class: "ferr", role: "alert", hidden: !failed, text: failed ? last.text : "" }),
    p.can.test ? h("div", { class: "try" },
      h("div", { class: "step-h" }, t("tryNow"),
        h("button", { type: "button", class: "btn small", text: tri?.running ? t("trying") : t("tryBtn"), disabled: !!tri?.running, onclick: async () => {
          trials.set(key, { running: true }); render();
          const r = await itemOp({ op: "test", provider: p.id, kind: kind.id, id: it.id, values: { ...values } });
          trials.set(key, r);
          if (r.ok && r.audio) playAudio(r.audio);
          render();
        } })),
      tri && !tri.running ? h("pre", { class: tri.ok ? "" : "bad", role: "status", text: tr(tri.text) }) : null,
      tri?.audio ? trialPlayer(tri.audio) : null) : null);
}
