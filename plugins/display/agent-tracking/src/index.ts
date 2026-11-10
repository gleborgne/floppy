import { definePlugin, T } from "@floppy/core";
import { registerDesktop } from "@floppy/toolkit";
import { watchTracking, emptyTracking } from "./tracking-source.ts";

export default definePlugin({
  manifest: {
    id: "display-agent-tracking", version: "0.1.0", licence: "MIT",
    description: "Affiche les faits du service de suivi des agents dans une vue de bureau.",
    optional: ["agentTracking"],
    addable: { section: "corps", label: T("Suivi des agents", "Agent tracking"), description: T("Une fenêtre pour suivre les agents.", "A window to track agents."), single: true },
  },
  apply(ctx) {
    if (!ctx.host) { ctx.items.status(T("inactif : pas d'affichage", "inactive: no display"), "warn"); return; }
    let snapshot = emptyTracking();
    let notify: (() => void) | undefined;
    const relay = watchTracking({ service: () => ctx.maybe("agentTracking"), changed: (fn) => {
      let active = true;
      ctx.on("service.changed", ({ name }) => { if (active) fn(name); });
      return () => { active = false; };
    }, publish: (value) => { snapshot = value; publish(); } });
    function publish() { notify?.(); }
    ctx.effect(() => relay.stop());
    registerDesktop(ctx, { id: "agents", title: { fr: "Suivi des agents", en: "Agent tracking" }, menus: ["tray", "avatar"], order: 20, view: { page: "tracking" } }, {
      snapshot: () => snapshot,
      subscribe: (fn) => { notify = fn; return () => { notify = undefined; }; },
      actions: { refresh: async () => { if (!await relay.refresh()) throw new Error("refresh.failed"); return { ok: true }; } },
    });
  },
});
