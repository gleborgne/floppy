// Vue de faits bornés : sélectionner et ouvrir ne transmet aucune instruction aux agents.
import { h, mount } from "./dom.ts";

const texts = {
  fr: {
    title: "Suivi des agents", search: "Chercher un agent ou un projet", projects: "Tous les projets", projectFilter: "Filtrer par projet",
    refresh: "Actualiser", refreshing: "Actualisation…", refreshError: "Actualisation impossible. Les dernières observations restent affichées.",
    attention: "À regarder", running: "En cours", recent: "Terminé récemment", empty: "Aucun agent nommé connu.",
    emptyHint: "Active un fournisseur de suivi dans les réglages. Les agents apparaîtront après leur première observation.",
    noMatch: "Aucun agent ne correspond à ce filtre.", inspect: "Sélectionne un agent pour lire sa mission et ses dernières observations.",
    missing: "Cet agent n'est plus dans la source. Sélectionne un autre agent pour l'inspecter.", close: "Fermer le détail",
    mission: "Mission", details: "Détails", progress: "Dernière progression connue", waitingReason: "Raison de l'attente", declaredResult: "Résultat déclaré",
    lastAction: "Dernière activité connue", changes: "Changements récents", noChanges: "Aucun changement disponible.",
    unavailable: "Non renseigné par la source", observed: "Observé", seen: "Vu pour la dernière fois", sync: "Dernière synchronisation", never: "Pas encore connue",
    now: "à l'instant", minutes: "min", hours: "h", ago: "il y a", staleRow: "Observation ancienne", freshRow: "Observation récente",
    connection: "Source", connected: "Connectée", stale: "Données anciennes", offline: "Hors ligne", unknown: "Inconnu",
    full: "Couverture complète", partial: "Couverture partielle : des agents ou des faits peuvent manquer", outage: "Source indisponible : derniers faits connus", unknownCoverage: "Couverture inconnue",
    working: "Travaille", waiting: "En attente", finished: "Terminé", idle: "Au repos", success: "Succès déclaré", failure: "Échec déclaré",
    interruption: "Interruption", unconfirmed: "Résultat non confirmé", live: "Présent", absent: "Absent de la source", outcome: "Résultat", presence: "Présence",
    diagnostics: "Diagnostic technique", diagnosticsHint: "Métadonnées uniquement ; aucun contenu de conversation.", noDiagnostics: "Aucune trace disponible.",
  },
  en: {
    title: "Agent tracking", search: "Search agents or projects", projects: "All projects", projectFilter: "Filter by project",
    refresh: "Refresh", refreshing: "Refreshing…", refreshError: "Refresh failed. The latest observations remain visible.",
    attention: "Needs attention", running: "In progress", recent: "Recently finished", empty: "No known named agents.",
    emptyHint: "Enable a tracking provider in Settings. Agents will appear after their first observation.",
    noMatch: "No agents match this filter.", inspect: "Select an agent to read its mission and latest observations.",
    missing: "This agent is no longer in the source. Select another agent to inspect it.", close: "Close details",
    mission: "Mission", details: "Details", progress: "Latest known progress", waitingReason: "Waiting reason", declaredResult: "Declared result",
    lastAction: "Latest known activity", changes: "Recent changes", noChanges: "No changes available.",
    unavailable: "Not supplied by the source", observed: "Observed", seen: "Last seen", sync: "Last synchronized", never: "Not known yet",
    now: "just now", minutes: "min", hours: "h", ago: "ago", staleRow: "Old observation", freshRow: "Recent observation",
    connection: "Source", connected: "Connected", stale: "Stale data", offline: "Offline", unknown: "Unknown",
    full: "Full coverage", partial: "Partial coverage: some agents or facts may be missing", outage: "Source unavailable: last known facts", unknownCoverage: "Unknown coverage",
    working: "Working", waiting: "Waiting", finished: "Finished", idle: "Idle", success: "Declared success", failure: "Declared failure",
    interruption: "Interrupted", unconfirmed: "Unconfirmed result", live: "Present", absent: "Absent from source", outcome: "Outcome", presence: "Presence",
    diagnostics: "Technical diagnostics", diagnosticsHint: "Metadata only; no conversation content.", noDiagnostics: "No traces available.",
  },
};
type Key = keyof typeof texts.fr;
const STALE_MS = 120_000;

/** Les chemins et références techniques ne servent jamais de libellés ordinaires. */
function safeText(value: string | undefined): string {
  return (value ?? "").slice(0, 4000)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|mnt)\/)[^\s,;]+/g, "[…] ")
    .replace(/\b(?:term_|task_|ctx_|run_)[a-zA-Z0-9_-]{8,}\b/g, "[…]")
    .replace(/(^|[\s(])\/[^\s,;)]+/g, "$1[…]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[…]");
}

export interface TrackingViewSource {
  get(): Promise<TrackingPayload | null>;
  refresh(): Promise<{ ok: boolean }>;
  onUpdate(cb: (data: TrackingPayload) => void): () => void;
}

export function startTracking(root: HTMLElement, api: TrackingViewSource): () => void {
  let data: TrackingSnapshot = { at: 0, agents: [], events: [], connection: { state: "unknown", coverage: "unknown" } };
  let lang: "fr" | "en" = "fr", search = "", project = "", selected: string | undefined;
  let busy = false, failed = false, received = false, disposed = false;
  const rowNodes = new Map<string, HTMLElement>();
  const t = (key: Key) => texts[lang][key];
  const age = (at: number | undefined) => {
    if (!at || !Number.isFinite(at)) return t("never");
    const delta = Math.max(0, Date.now() - at);
    if (delta < 60_000) return t("now");
    const v = delta < 3600_000 ? `${Math.floor(delta / 60_000)} ${t("minutes")}` : `${Math.floor(delta / 3600_000)} ${t("hours")}`;
    return lang === "fr" ? `${t("ago")} ${v}` : `${v} ${t("ago")}`;
  };
  const old = (a: TrackingRecord) => !a.observedAt || Date.now() - a.observedAt > STALE_MS;
  const group = (a: TrackingRecord): "attention" | "running" | "recent" =>
    old(a) || a.presence !== "live" || ["waiting", "unknown", "idle"].includes(a.activity) || ["failure", "interruption", "unconfirmed"].includes(a.outcome)
      ? "attention" : a.activity === "finished" ? "recent" : "running";
  const plain = (value: string | undefined) => safeText(value) || t("unavailable");
  const choose = (id: string) => { selected = selected === id ? undefined : id; render(); };
  const refresh = async () => {
    if (busy) return;
    busy = true; failed = false; render();
    try { failed = !(await api.refresh()).ok; } catch { failed = true; }
    finally { busy = false; if (!disposed) render(); }
  };
  function render() {
    if (disposed) return;
    const activeRow = [...rowNodes].find(([, el]) => el === document.activeElement)?.[0];
    document.documentElement.lang = lang; document.title = t("title");
    const filtered = data.agents.filter((a) => (!project || a.project === project) &&
      `${a.label} ${a.project} ${a.workspaceLabel ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const a = data.agents.find((a) => a.id === selected);
    const state = data.connection.state === "connected" && (!data.connection.lastSyncAt || Date.now() - data.connection.lastSyncAt > STALE_MS) ? "stale" : data.connection.state;
    const connectionKey = state as Key;
    const coverageKey = data.connection.coverage === "unknown" ? "unknownCoverage" : data.connection.coverage;
    const row = (a: TrackingRecord) => h("button", {
      key: a.id, class: "agent-row", type: "button", "aria-expanded": selected === a.id ? "true" : "false", "aria-controls": "agent-detail",
      ref: (el) => { if (el) rowNodes.set(a.id, el); else rowNodes.delete(a.id); },
      onclick: () => choose(a.id),
      onkeydown: (e) => {
        const rows = [...root.querySelectorAll<HTMLButtonElement>(".agent-row")];
        const index = rows.indexOf(e.currentTarget as unknown as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? index + 1 : e.key === "ArrowUp" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
        if (next >= 0 && rows[next]) { e.preventDefault(); rows[next]!.focus(); }
      },
    }, h("span", { class: "row-head" }, h("strong", { text: plain(a.label) }), h("span", { class: `chip ${group(a) === "attention" ? "warn" : ""}`, text: t(a.activity) })),
    h("span", { class: "project", text: `${plain(a.project)}${a.workspaceLabel ? ` · ${plain(a.workspaceLabel)}` : ""}` }),
    h("span", { class: "preview", text: plain(a.waitingReason ?? a.progress ?? a.lastAction ?? a.declaredResult) }),
    a.outcome !== "unknown" && h("span", { class: "outcome", text: t(a.outcome) }),
    h("span", { class: "freshness", text: `${t(a.presence)} · ${t(old(a) ? "staleRow" : "freshRow")} · ${age(a.observedAt)}` }));
    const fact = (label: Key, value: string | undefined) => h("div", { class: "fact", key: label }, h("dt", { text: t(label) }), h("dd", { text: plain(value) }));
    mount(h("div", { class: "tracking-shell" },
      h("header", null, h("h1", { text: t("title") }), h("button", { type: "button", class: "refresh", disabled: busy, onclick: refresh, text: t(busy ? "refreshing" : "refresh") })),
      h("div", { class: `source ${state}`, role: "status" }, h("strong", { text: `${t("connection")} · ${t(connectionKey)}` }),
        h("span", { text: t(coverageKey) }), h("span", { text: `${t("sync")} : ${age(data.connection.lastSyncAt)}` })),
      failed && h("p", { class: "error", role: "alert", text: t("refreshError") }),
      h("div", { class: "filters" },
        h("input", { type: "search", value: search, placeholder: t("search"), "aria-label": t("search"), oninput: (e) => { search = e.currentTarget.value.slice(0, 200); render(); } }),
        h("select", { value: project, "aria-label": t("projectFilter"), onchange: (e) => { project = e.currentTarget.value; render(); } },
          h("option", { value: "", text: t("projects") }), [...new Set(data.agents.map((a) => a.project))].sort().map((p) => h("option", { key: p, value: p, text: plain(p) })))),
      h("div", { class: "workspace" }, !data.agents.length ? h("div", { class: "empty" }, h("h2", { text: t("empty") }), h("p", { text: t("emptyHint") })) :
        !filtered.length ? h("p", { class: "empty", text: t("noMatch") }) :
          h("nav", { "aria-label": t("title"), class: "agent-list" }, (["attention", "running", "recent"] as const).map((g) => {
            const rows = filtered.filter((a) => group(a) === g).sort((a, b) => b.observedAt - a.observedAt);
            return rows.length ? h("section", { key: g }, h("h2", { class: "group-title", text: t(g) }), rows.map(row)) : null;
          })),
      h("section", { id: "agent-detail", class: "agent-detail", "aria-label": a ? plain(a.label) : t("details") },
        a ? [h("div", { class: "detail-head" }, h("h2", { text: plain(a.label) }), h("button", { type: "button", onclick: () => {
          const id = selected; selected = undefined; render();
          if (id) rowNodes.get(id)?.focus();
        }, text: t("close") })),
        h("p", { class: "project", text: `${plain(a.project)}${a.workspaceLabel ? ` · ${plain(a.workspaceLabel)}` : ""}` }),
        h("dl", null, fact("mission", a.mission), fact("details", a.details), fact("progress", a.progress), fact("waitingReason", a.waitingReason),
          fact("declaredResult", a.declaredResult), fact("lastAction", a.lastAction), fact("outcome", t(a.outcome)), fact("presence", t(a.presence)),
          fact("observed", age(a.observedAt)), fact("seen", age(a.lastSeenAt))),
        h("h3", { text: t("changes") }),
        data.events.some((e) => e.agentId === a.id) ? h("ol", { class: "events" }, data.events.filter((e) => e.agentId === a.id).slice(-30).reverse().map((e) =>
          h("li", { key: e.eventId }, h("span", { class: "muted", text: age(e.at) }), h("p", { text: plain(e.summary) })))) : h("p", { class: "muted", text: t("noChanges") })]
          : h("p", { class: "muted", text: t(selected ? "missing" : "inspect") }))),
      h("details", { class: "diagnostics" }, h("summary", { text: t("diagnostics") }), h("p", { class: "muted", text: t("diagnosticsHint") }),
        data.diagnostics?.length ? h("ul", null, data.diagnostics.slice(-20).map((d, i) => h("li", { key: i },
          h("time", { text: age(d.at) }), h("code", { text: [d.component, d.stage, d.reason, d.correlationId, d.agentId, d.eventId, d.callId].filter(Boolean).join(" · ") }))))
          : h("p", { text: t("noDiagnostics") })),
    ), root);
    if (activeRow && rowNodes.get(activeRow) !== document.activeElement) rowNodes.get(activeRow)?.focus();
  }
  const update = (payload: TrackingPayload) => {
    if (disposed) return;
    received = true; data = payload.snapshot; lang = payload.lang === "en" ? "en" : "fr"; render();
  };
  const unsubscribe = api.onUpdate(update);
  void api.get().then((payload) => { if (payload && !received) update(payload); }, () => { failed = true; render(); });
  const clock = setInterval(render, 30_000);
  render();
  return () => { disposed = true; unsubscribe(); clearInterval(clock); };
}
