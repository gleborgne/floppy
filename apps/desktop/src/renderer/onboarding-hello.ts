// Fenêtre « Bienvenue » : l'écran « Bonjour » (langue, verdict sur la machine, dossier de Floppy) et le détail de la machine.
import { h, icon } from "./onboarding-dom.ts";
import { api, changeLanguage, chooseManual, load, render, S, t, txt } from "./onboarding-state.ts";
import { pageHead } from "./onboarding-list.ts";
import { gb, GIB_BYTES, machineRows, machineVerdict, MANUAL_CHOICES, needsManual } from "./onboarding-view.ts";

/** Une ligne de la carte : icône, titre, phrase et un bouton à droite. */
function line(ic: HTMLElement | SVGElement, title: string, sub: string, action?: HTMLElement | null, tone?: "good" | "warn"): HTMLElement {
  return h("div", { class: "line" }, h("span", { class: `lic${tone ? ` ${tone}` : ""}` }, ic),
    h("div", { class: "line-text" }, h("span", { class: "t", text: title }), h("span", { class: "s", text: sub })), action);
}

/** Nouveau dossier de travail : le noyau repart dans ce dossier ; on relit le plan quand il répond de nouveau. */
async function chooseHome(): Promise<void> {
  if (!api) return;
  S.error = "";
  const r = await api.chooseHome();
  if (!r || r.canceled) return;
  if (!r.ok) { S.error = txt(r.text) || t("failed"); await load({}); return; }
  S.plan = null;
  S.busy = true;
  document.getElementById("content")?.replaceChildren(h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("homeMoving") })));
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const next = await api.plan({});
    if (next?.ok) break;
  }
  S.busy = false;
  await load({});
}

/** Le détail de la machine : ce qui a été lu, le choix à la main, la relecture, les programmes de cerveau trouvés. */
function detail(plan: OnboardingPlan): HTMLElement {
  const nodes: (HTMLElement | null)[] = [
    h("div", { class: "card" }, machineRows(plan.machine, t, S.lang).map(([k, v]) => h("div", { class: "row" }, h("span", { class: "k", text: k }), h("span", { class: "v", text: v })))),
  ];
  if (needsManual(plan)) {
    nodes.push(h("p", { class: "label", text: t("manual") }));
    nodes.push(h("div", { class: "seg", role: "radiogroup", "aria-label": t("manual") }, MANUAL_CHOICES.map((g) => h("button", {
      type: "button", role: "radio", "aria-checked": String(S.manual === g), k: `manual:${g}`,
      text: g === 0 ? t("manualNone") : gb(g * GIB_BYTES, S.lang), onclick: () => chooseManual(g),
    }))));
  }
  if (plan.agents?.length) {
    nodes.push(h("p", { class: "label", text: t("agents") }));
    nodes.push(h("div", { class: "card" }, plan.agents.map((a) => h("div", { class: "row" },
      h("span", { class: "k", text: txt(a.label) }),
      h("span", { class: "v" }, h("span", { class: a.found ? "chip plain" : "chip warn", text: a.found ? t("found") : t("notFound") }))))));
  }
  nodes.push(h("div", { class: "detail-actions" }, h("button", { type: "button", class: "btn small", text: t("reread"), disabled: S.busy, k: "reread", onclick: () => void load({ fresh: true }) })));
  return h("div", { class: "detail" }, nodes);
}

export function helloPage(): HTMLElement[] {
  const plan = S.plan;
  const head = pageHead(t("hello.title"), t("hello.lead"));
  if (!plan) return [head, h("div", { class: "wait" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text: t("loading") }))];
  const verdict = machineVerdict(plan);
  const unread = verdict === "unread";
  // Rien n'a pu être lu : le choix à la main est montré tout de suite.
  const open = S.detail || unread;
  const lines: HTMLElement[] = [
    line(icon("globe", 22), t(`lang.${S.lang}`), t("langSub"),
      h("button", { type: "button", class: "btn small", text: t("change"), "aria-expanded": String(S.langOpen), disabled: S.busy, k: "lang", onclick: () => { S.langOpen = !S.langOpen; render(); } })),
  ];
  if (S.langOpen) {
    lines.push(h("div", { class: "line sub" }, h("div", { class: "seg", role: "radiogroup", "aria-label": t("langPick") },
      (["fr", "en"] as const).map((l) => h("button", {
        type: "button", role: "radio", "aria-checked": String(S.lang === l), text: l === "fr" ? "Français" : "English", k: `lang:${l}`,
        onclick: () => { if (S.lang !== l) void changeLanguage(l); },
      })))));
  }
  lines.push(line(icon(unread || verdict === "tight" ? "alert" : "check", 22), unread ? t("unreadTitle") : t("looked"), t(`verdict.${verdict}`),
    unread ? null : h("button", { type: "button", class: "btn small", text: t(open ? "hideDetail" : "showDetail"), "aria-expanded": String(open), k: "detail", onclick: () => { S.detail = !S.detail; render(); } }),
    unread || verdict === "tight" ? "warn" : "good"));
  if (open) lines.push(detail(plan));
  if (plan.home) {
    lines.push(line(icon("folder", 22), t("home"), plan.home,
      h("button", { type: "button", class: "btn small", text: t("homeChange"), disabled: S.busy || !api?.chooseHome, k: "home", onclick: () => void chooseHome() })));
  }
  return [head, h("div", { class: "card lines" }, lines), h("p", { class: "hint", text: t("helloFoot") })];
}
