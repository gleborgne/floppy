// Panneau « Assistant IA » de la fenêtre des réglages : discute avec le CLI d'un agent de code de l'utilisateur
// (service « coder » du noyau, qui liste lui-même ses agents : aucun nom en dur ici). Tout le texte reçu est inséré avec textContent : jamais de innerHTML.
// Sans window.floppyCoder (capture hors de l'app), le panneau montre une conversation d'exemple.
const api = window.floppyCoder;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
/** Texte du noyau : chaîne simple ou { fr, en }, dans la langue de la page. */
const tx = (x: CoderText | null | undefined): string => {
  if (x === undefined || x === null) return "";
  if (typeof x === "string") return x;
  const l = document.documentElement.lang || "fr";
  return x[l] ?? x.fr ?? Object.values(x).find((v) => typeof v === "string") ?? "";
};
type Lang = "fr" | "en";
/** Textes du panneau : un jeu par langue (mêmes clés). */
interface Texts {
  title: string; fresh: string; close: string; agentLabel: string; modeLabel: string;
  modes: Record<string, string>;
  suggestions: Record<string, string[]>;
  placeholder: string; inputLabel: string; send: string; stop: string;
  down: string; none: string; retry: string;
  unchanged: (n: number) => string; moreLines: (n: number) => string; newFile: string; diffLabel: string;
  tools: Record<string, string>;
  status: Record<string, string>;
  permTitle: string; techDetails: string; allow: string; deny: string; allowed: string; denied: string;
  signInTitle: (name: string) => string; signInDesc: string;
  copy: string; copied: string; copyFailed: string;
  error: string; stopped: string;
  introPlugin: string; introReglages: string; introPluginMore: string; introReglagesMore: string;
  confirmSwitch: string; confirmFresh: string;
  demo: string; startFailed: string; show: string;
}
// Textes du panneau (fr / en) : la langue est celle de la page (<html lang>), changée par la fenêtre des réglages.
const TXT: Record<Lang, Texts> = {
  fr: {
    title: "Assistant IA", fresh: "Nouvelle conversation", close: "Fermer", agentLabel: "Assistant", modeLabel: "Mode",
    modes: { settings: "Réglages", plugin: "Créer un plugin" },
    suggestions: {
      reglages: ["Rends Floppy plus discret", "Explique-moi les connecteurs"],
      plugin: ["Crée un plugin qui me rappelle de boire de l'eau toutes les heures", "Explique-moi comment marche un plugin"],
    },
    placeholder: "Écris ta demande…", inputLabel: "Message à l'assistant", send: "Envoyer", stop: "Stop",
    down: "Assistant indisponible : le service n'est pas démarré.", none: "Aucun agent de code trouvé. Installe son CLI, puis réessaie.", retry: "Réessayer",
    unchanged: (n) => `${n} lignes inchangées`, moreLines: (n) => `… ${n} lignes de plus`, newFile: "nouveau fichier", diffLabel: "Aperçu des changements",
    tools: {
      lister_reglages: "Regarde tes réglages", changer_reglage: "Change un réglage", annuler_reglage: "Annule le dernier changement",
      etat_plugins: "Regarde l'état des plugins", lister_elements: "Regarde tes éléments", types_elements: "Regarde ce qu'on peut ajouter",
      activer_element: "Active ou désactive un élément", essayer_element: "Essaie l'élément", ajouter_element: "Ajoute l'élément",
      modifier_element: "Modifie l'élément", supprimer_element: "Supprime l'élément", tester_plugin: "Teste le plugin",
      recharger_plugins: "Recharge les plugins", WebSearch: "Cherche sur le web", WebFetch: "Lit une page web",
      web_search: "Cherche sur le web", Read: "Lit un fichier", Write: "Écrit un fichier", Edit: "Modifie un fichier",
      Glob: "Cherche des fichiers", Grep: "Cherche dans les fichiers",
    },
    status: { running: "en cours", done: "terminé", failed: "échec" },
    permTitle: "Autorisation demandée", techDetails: "Détails techniques", allow: "Autoriser", deny: "Refuser", allowed: "Autorisé", denied: "✖ Refusé",
    signInTitle: (name) => `Connexion à ${name} nécessaire`, signInDesc: "Ouvre un terminal, lance cette commande, connecte-toi, puis renvoie ton message.",
    copy: "Copier", copied: "Copié", copyFailed: "Copie impossible",
    error: "Une erreur est survenue.", stopped: "Arrêté.",
    introPlugin: "Décris le plugin que tu veux.", introReglages: "Dis ce que tu veux changer.",
    introPluginMore: "L'assistant écrit le plugin dans ton dossier, te montre chaque fichier avant de l'enregistrer, puis le vérifie.",
    introReglagesMore: "L'assistant peut lire et changer les réglages de Floppy. Il utilise ton abonnement à l'agent de code choisi.",
    confirmSwitch: "Cela démarre une nouvelle conversation. Continuer ?", confirmFresh: "Effacer cette conversation et en démarrer une nouvelle ?",
    demo: "(démonstration) l'assistant n'est pas relié dans cette capture.", startFailed: "Impossible de démarrer la conversation.",
    show: "Assistant IA",
  },
  en: {
    title: "AI assistant", fresh: "New conversation", close: "Close", agentLabel: "Assistant", modeLabel: "Mode",
    modes: { settings: "Settings", plugin: "Create a plugin" },
    suggestions: {
      reglages: ["Make Floppy more discreet", "Explain connectors to me"],
      plugin: ["Create a plugin that reminds me to drink water every hour", "Explain to me how a plugin works"],
    },
    placeholder: "Write your request…", inputLabel: "Message to the assistant", send: "Send", stop: "Stop",
    down: "Assistant unavailable: the service is not running.", none: "No coding agent found. Install its CLI, then try again.", retry: "Try again",
    unchanged: (n) => `${n} unchanged lines`, moreLines: (n) => `… ${n} more lines`, newFile: "new file", diffLabel: "Preview of the changes",
    tools: {
      lister_reglages: "Looks at your settings", changer_reglage: "Changes a setting", annuler_reglage: "Undoes the last change",
      etat_plugins: "Looks at the plugins' state", lister_elements: "Looks at your items", types_elements: "Looks at what can be added",
      activer_element: "Turns an item on or off", essayer_element: "Tries the item", ajouter_element: "Adds the item",
      modifier_element: "Edits the item", supprimer_element: "Deletes the item", tester_plugin: "Tests the plugin",
      recharger_plugins: "Reloads the plugins", WebSearch: "Searches the web", WebFetch: "Reads a web page",
      web_search: "Searches the web", Read: "Reads a file", Write: "Writes a file", Edit: "Edits a file",
      Glob: "Looks for files", Grep: "Searches in files",
    },
    status: { running: "running", done: "done", failed: "failed" },
    permTitle: "Permission requested", techDetails: "Technical details", allow: "Allow", deny: "Deny", allowed: "Allowed", denied: "✖ Denied",
    signInTitle: (name) => `Sign-in to ${name} required`, signInDesc: "Open a terminal, run this command, sign in, then send your message again.",
    copy: "Copy", copied: "Copied", copyFailed: "Copy failed",
    error: "An error occurred.", stopped: "Stopped.",
    introPlugin: "Describe the plugin you want.", introReglages: "Say what you want to change.",
    introPluginMore: "The assistant writes the plugin in your folder, shows you each file before saving it, then checks it.",
    introReglagesMore: "The assistant can read and change Floppy's settings. It uses your subscription to the chosen coding agent.",
    confirmSwitch: "This starts a new conversation. Continue?", confirmFresh: "Clear this conversation and start a new one?",
    demo: "(demo) the assistant is not connected in this capture.", startFailed: "Could not start the conversation.",
    show: "AI assistant",
  },
};
const pageLang = (): Lang => (document.documentElement.lang === "en" ? "en" : "fr");
const L = <K extends keyof Texts>(k: K): Texts[K] => TXT[pageLang()][k] ?? TXT.fr[k];
const DIFF_MAX = 400;
const FENCE = "`".repeat(3);

const store = {
  get(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* sans stockage */ } },
};

// ------------------------------------------------------------------ texte : mini-markdown sans HTML
function inline(parent: HTMLElement, text: string) {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    parent.append(tok.startsWith("`") ? el("code", "", tok.slice(1, -1)) : el("strong", "", tok.slice(2, -2)));
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(target: HTMLElement, raw: string) {
  const frag = document.createDocumentFragment();
  const parts = raw.split(FENCE);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { // bloc de code (le dernier peut ne pas être fermé : texte en cours)
      const nl = part.indexOf("\n");
      const code = nl >= 0 ? part.slice(nl + 1) : "";
      const pre = el("pre", "code");
      pre.append(el("code", "", code.replace(/\n$/, "")));
      frag.append(pre);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split("\n").filter((l) => l.trim());
      const first = lines[0];
      if (first === undefined) continue;
      const item = /^\s*([-*•]|\d+[.)])\s+/;
      if (lines.every((l) => item.test(l))) {
        const list = el(/^\s*\d/.test(first) ? "ol" : "ul");
        for (const l of lines) { const li = el("li"); inline(li, l.replace(item, "")); list.append(li); }
        frag.append(list);
      } else {
        const p = el("p");
        lines.forEach((l, j) => { if (j) p.append(el("br")); inline(p, l); });
        frag.append(p);
      }
    }
  });
  target.replaceChildren(frag);
}

// ------------------------------------------------------------------ diff
type DiffKind = " " | "-" | "+" | "…";
function diffLines(before: string | undefined, after: string | undefined): [DiffKind, string][] {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const mid: [DiffKind, string][] = [];
  const x = a.slice(s, ea), y = b.slice(s, eb);
  if (x.length * y.length <= 250000) { // plus longue sous-suite commune
    const t = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    // Le tableau fait (x+1) × (y+1) : aucune lecture hors bornes, d'où les `!`.
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    let i = 0, j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { mid.push([" ", x[i]!]); i++; j++; }
      else if (t[i + 1]![j]! >= t[i]![j + 1]!) mid.push(["-", x[i++]!]);
      else mid.push(["+", y[j++]!]);
    }
    while (i < x.length) mid.push(["-", x[i++]!]);
    while (j < y.length) mid.push(["+", y[j++]!]);
  } else {
    for (const l of x) mid.push(["-", l]);
    for (const l of y) mid.push(["+", l]);
  }
  const ctx = 3, out: [DiffKind, string][] = [];
  const head = a.slice(Math.max(0, s - ctx), s).map((l): [DiffKind, string] => [" ", l]);
  const tail = a.slice(ea, ea + ctx).map((l): [DiffKind, string] => [" ", l]);
  if (s > ctx) out.push(["…", L("unchanged")(s - ctx)]);
  out.push(...head, ...mid, ...tail);
  if (a.length - ea > ctx) out.push(["…", L("unchanged")(a.length - ea - ctx)]);
  return out;
}

function diffView(diff: CoderDiff) {
  const box = el("div", "diff");
  const lines = diffLines(diff.before, diff.after);
  const pre = el("div", "diff-body");
  pre.tabIndex = 0;
  pre.setAttribute("role", "region");
  pre.setAttribute("aria-label", L("diffLabel"));
  for (const [k, text] of lines.slice(0, DIFF_MAX)) {
    const row = el("div", k === "+" ? "dl add" : k === "-" ? "dl del" : k === "…" ? "dl skip" : "dl");
    row.append(el("span", "sign", k === "…" ? "" : k), el("span", "txt", text));
    pre.append(row);
  }
  if (lines.length > DIFF_MAX) pre.append(el("div", "dl skip", L("moreLines")(lines.length - DIFF_MAX)));
  const adds = lines.filter((l) => l[0] === "+").length, dels = lines.filter((l) => l[0] === "-").length;
  const stat = el("div", "diff-stat", diff.before === undefined ? `${L("newFile")} · +${adds}` : `+${adds} −${dels}`);
  box.append(stat, pre);
  return box;
}

// ------------------------------------------------------------------ panneau
export function initAssistant() {
  const rootEl = document.getElementById("assistant");
  const toggleEl = document.getElementById("assistant-toggle");
  if (!rootEl || !toggleEl) return;
  const root: HTMLElement = rootEl;
  const toggle = toggleEl as HTMLButtonElement;

  let agent = store.get("assistant.agent", "");
  let mode = store.get("assistant.mode", "settings") === "plugin" ? "plugin" : "settings";
  let agents: CoderAgent[] | null = null;       // agents donnés par le service, ou null (service absent)
  let availKnown = false;
  let sessionId: string | null = null;
  let busy = false;
  let starting = false;
  let curText: { node: HTMLElement; raw: string } | null = null;      // { node, raw } : bulle de l'assistant en cours de flux
  const tools = new Map<string, ToolView>(); // id d'outil → vue de l'outil
  let empty = true;

  interface ToolView { det: HTMLDetailsElement; status: HTMLElement; out: HTMLElement; state: string }
  // ---- ouverture / fermeture
  const mq = window.matchMedia("(max-width: 900px)");
  let open = !mq.matches && store.get("assistant.open", "1") !== "0";
  const applyOpen = () => {
    root.hidden = !open;
    root.classList.toggle("overlay", mq.matches);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.onclick = () => { open = !open; if (!mq.matches) store.set("assistant.open", open ? "1" : "0"); applyOpen(); if (open) input.focus(); };
  mq.addEventListener("change", () => { open = !mq.matches && store.get("assistant.open", "1") !== "0"; applyOpen(); });

  // ---- structure
  const head = el("div", "as-head");
  const title = el("div", "as-title");
  const titleH = el("h2");
  title.append(titleH);
  const fresh = el("button", "ghost small");
  fresh.type = "button";
  const close = el("button", "ghost small as-close");
  close.type = "button";
  close.onclick = () => toggle.click();
  title.append(fresh, close);

  const picks = el("div", "as-picks");
  const agentSeg = seg(() => L("agentLabel"), () => (agents ?? []).map((a): [string, string] => [a.id, tx(a.label)]), () => agent, (v) => changeSetup("agent", v));
  const modeSeg = seg(() => L("modeLabel"), () => Object.entries(L("modes")), () => mode, (v) => changeSetup("mode", v));
  picks.append(agentSeg.node, modeSeg.node);
  const notice = el("div", "as-notice");
  notice.hidden = true;
  head.append(title, picks, notice);

  const log = el("div", "as-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.tabIndex = 0;
  const suggest = el("div", "as-suggest");

  const form = el("form", "as-composer");
  const input = el("textarea");
  input.rows = 2;
  const send = el("button", "primary");
  send.type = "submit";
  const stop = el("button", "stop");
  stop.type = "button";
  stop.hidden = true;
  const buttons = el("div", "as-buttons");
  buttons.append(send, stop);
  form.append(input, buttons);
  root.append(head, log, suggest, form);

  /** Textes fixes du panneau, dans la langue de la page. */
  function applyTexts() {
    titleH.textContent = L("title");
    fresh.textContent = L("fresh");
    close.textContent = L("close");
    input.placeholder = L("placeholder");
    input.setAttribute("aria-label", L("inputLabel"));
    send.textContent = L("send");
    stop.textContent = L("stop");
    root.setAttribute("aria-label", L("show"));
    toggle.textContent = L("show");
  }

  function seg(label: () => string, opts: () => [string, string][], get: () => string, set: (v: string) => void) {
    const node = el("div", "seg small");
    node.setAttribute("role", "radiogroup");
    const out = { node, btns: [] as HTMLButtonElement[], refresh() {} };
    out.refresh = () => {
      node.setAttribute("aria-label", label());
      const entries = opts();
      if (entries.map((e) => e.join("|")).join(";") !== out.btns.map((b) => `${b.dataset.value}|${b.textContent}`).join(";")) {
        out.btns = entries.map(([value, text]) => {
          const b = el("button", "", text);
          b.type = "button"; b.setAttribute("role", "radio"); b.dataset.value = value;
          b.onclick = () => set(value);
          return b;
        });
        node.replaceChildren(...out.btns);
      }
      out.btns.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === get())));
    };
    return out;
  }

  const isAvailable = (id: string) => !!agents?.some((a) => a.id === id && a.available);

  // ---- état affiché
  function refresh() {
    agentSeg.refresh(); modeSeg.refresh();
    for (const b of agentSeg.btns) b.disabled = !!api && availKnown && !isAvailable(b.dataset.value ?? "");
    const down = !!api && availKnown && !agents;
    const none = !!api && availKnown && !!agents && !agents.some((a) => a.available);
    notice.hidden = !(down || none);
    notice.replaceChildren();
    if (down || none) {
      notice.append(el("span", "", down ? L("down") : L("none")));
      const retry = el("button", "ghost small", L("retry"));
      retry.type = "button";
      retry.onclick = checkAvailable;
      notice.append(retry);
    }
    const blocked = down || none || (!!api && availKnown && !!agents && !isAvailable(agent));
    input.disabled = blocked;
    send.disabled = blocked || busy || starting;
    stop.hidden = !busy;
    suggest.replaceChildren();
    if (empty && !blocked) {
      for (const t of L("suggestions")[mode] ?? []) {
        const c = el("button", "suggest", t);
        c.type = "button";
        c.onclick = () => submit(t);
        suggest.append(c);
      }
    }
  }

  async function checkAvailable() {
    if (!api) return;
    try { agents = await api.agents(); } catch { agents = null; }
    if (!Array.isArray(agents)) agents = null;
    availKnown = true;
    // Agent choisi absent ou indisponible : le premier disponible prend le relais.
    if (agents && !isAvailable(agent)) agent = agents.find((a) => a.available)?.id ?? agent;
    refresh();
  }

  // ---- transcript
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  function add(node: HTMLElement) {
    const stick = atBottom();
    if (empty) { empty = false; log.replaceChildren(); }
    log.append(node);
    if (stick) log.scrollTop = log.scrollHeight;
    refresh();
  }
  const scrollDown = () => { if (atBottom()) log.scrollTop = log.scrollHeight; };
  /** Message court dans la conversation. text : un texte, ou une fonction (texte de la fenêtre, suit la langue). */
  function note(text: string | (() => string), bad?: boolean) {
    const n = el("div", bad ? "msg err" : "msg info");
    if (typeof text === "function") live(() => { n.textContent = text(); }); else n.textContent = text;
    n.setAttribute("role", bad ? "alert" : "note");
    add(n);
  }

  function addUser(text: string) { curText = null; add(el("div", "msg user", text)); }

  function addText(delta: string) {
    if (!curText) { curText = { node: el("div", "msg bot"), raw: "" }; add(curText.node); }
    curText.raw += delta;
    renderMarkdown(curText.node, curText.raw);
    scrollDown();
  }

  const short = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  };
  // Ce que fait chaque outil, en clair.
  const toolLabel = (name: string | undefined) => L("tools")[String(name ?? "").replace(/^mcp__floppy__/, "")] ?? String(name ?? "");
  const ICON: Record<string, string> = { done: "check", failed: "x" };
  // Textes déjà affichés dans la conversation : refaits quand la langue de la page change.
  let relabel: (() => void)[] = [];
  const live = (fn: () => void) => { fn(); relabel.push(fn); };

  function upsertTool(ev: Extract<CoderEvent, { type: "tool" }>) {
    curText = null;
    let t = tools.get(ev.id);
    if (!t) {
      // Une phrase simple ; le nom technique, les paramètres et le résultat seulement si on ouvre.
      const det = el("details", "tool");
      const sum = el("summary");
      const status = el("span", "tstat");
      const name = el("span", "tname");
      sum.append(status, name);
      const tech = el("div", "ttech", `${String(ev.name ?? "").replace(/^mcp__floppy__/, "")} ${ev.input !== undefined ? short(ev.input) : ""}`);
      const out = el("pre", "tout");
      det.append(sum, tech, out);
      t = { det, status, out, state: ev.status };
      tools.set(ev.id, t);
      const tt = t;
      live(() => { name.textContent = toolLabel(ev.name); tt.status.setAttribute("aria-label", L("status")[tt.state] ?? ""); });
      add(det);
    }
    t.state = ev.status;
    t.status.className = `tstat ${ev.status}`;
    const iconName = ICON[ev.status];
    t.status.replaceChildren(...(iconName && window.lucideIcon ? [window.lucideIcon(iconName)] : []));
    t.status.setAttribute("aria-label", L("status")[ev.status] ?? "");
    if (ev.output) t.out.textContent = ev.output.length > 4000 ? ev.output.slice(0, 4000) + "\n…" : ev.output;
    t.det.classList.toggle("has-out", !!ev.output);
    scrollDown();
  }

  function addPermission(ev: Extract<CoderEvent, { type: "permission" }>, answer: (id: string, allow: boolean) => void, focus: boolean) {
    curText = null;
    const card = el("div", "perm");
    card.setAttribute("role", "group");
    const ptitle = el("div", "perm-title");
    live(() => { card.setAttribute("aria-label", L("permTitle")); ptitle.textContent = L("permTitle"); });
    card.append(ptitle);
    card.append(el("div", "perm-desc", ev.description || ev.tool));
    if (ev.diff?.path) card.append(el("div", "perm-path", ev.diff.path));
    if (ev.diff && (ev.diff.before !== undefined || ev.diff.after !== undefined)) card.append(diffView(ev.diff));
    else if (ev.input !== undefined) {
      const more = el("details", "perm-more");
      const sum = el("summary");
      live(() => { sum.textContent = L("techDetails"); });
      more.append(sum, el("pre", "tout shown", JSON.stringify(ev.input, null, 2)));
      card.append(more);
    }
    const acts = el("div", "perm-acts");
    const yes = el("button", "primary");
    const no = el("button", "ghost");
    yes.type = no.type = "button";
    const state = el("div", "perm-state");
    let decided: boolean | null = null;
    live(() => {
      yes.textContent = L("allow");
      no.textContent = L("deny");
      if (decided !== null) state.textContent = decided ? L("allowed") : L("denied");
    });
    const decide = (allow: boolean) => {
      acts.hidden = true;
      decided = allow;
      state.textContent = allow ? L("allowed") : L("denied");
      state.className = `perm-state ${allow ? "ok" : "ko"}`;
      card.classList.add("answered");
      answer(ev.id, allow);
    };
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    acts.append(yes, no);
    card.append(acts, state);
    add(card);
    if (focus) yes.focus({ preventScroll: true });
  }

  function addSignIn() {
    const info = agents?.find((a) => a.id === agent);
    const cmd = tx(info?.loginHint);
    const card = el("div", "perm signin");
    const stitle = el("div", "perm-title");
    const sdesc = el("div", "perm-desc");
    card.append(stitle, sdesc);
    const line = el("div", "cmd");
    line.append(el("code", "", cmd));
    const copy = el("button", "ghost small");
    copy.type = "button";
    live(() => { stitle.textContent = L("signInTitle")(tx(info?.label) || agent); sdesc.textContent = L("signInDesc"); copy.textContent = L("copy"); });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(cmd); copy.textContent = L("copied"); } catch { copy.textContent = L("copyFailed"); }
      setTimeout(() => { copy.textContent = L("copy"); }, 2000);
    };
    line.append(copy);
    card.append(line);
    add(card);
  }

  // ---- événements du service
  function handle(ev: CoderEvent) {
    if (ev.type === "status") { busy = ev.status === "busy"; starting = ev.status === "starting"; refresh(); }
    else if (ev.type === "text") addText(ev.delta ?? "");
    else if (ev.type === "tool") upsertTool(ev);
    else if (ev.type === "permission") addPermission(ev, (id, allow) => { if (api && sessionId) api.answer(sessionId, id, allow); }, true);
    else if (ev.type === "done") {
      busy = false; starting = false; curText = null;
      if (ev.signIn) addSignIn();
      else if (ev.stopReason === "error") note(ev.error ? () => tx(ev.error) : () => L("error"), true);
      else if (ev.stopReason === "cancelled") note(() => L("stopped"));
      refresh();
      if (!input.disabled) input.focus({ preventScroll: true });
    }
  }
  api?.onEvent((ev) => { if (ev && ev.sessionId === sessionId) handle(ev); });

  // ---- actions
  function intro() {
    const d = el("div", "as-intro");
    d.append(el("p", "big", mode === "plugin" ? L("introPlugin") : L("introReglages")));
    d.append(el("p", "", mode === "plugin" ? L("introPluginMore") : L("introReglagesMore")));
    return d;
  }
  function reset() {
    if (api && sessionId) api.close(sessionId);
    sessionId = null; busy = false; starting = false; curText = null; empty = true;
    tools.clear();
    relabel = [];
    log.replaceChildren(intro());
    refresh();
  }
  function changeSetup(what: "agent" | "mode", value: string) {
    if ((what === "agent" ? agent : mode) === value) return;
    if (!empty && !confirm(L("confirmSwitch"))) { refresh(); return; }
    if (what === "agent") agent = value; else mode = value;
    store.set(`assistant.${what}`, value);
    reset();
  }
  fresh.onclick = () => { if (empty || confirm(L("confirmFresh"))) reset(); };

  async function submit(text: unknown) {
    const msg = String(text ?? "").trim();
    if (!msg || busy || starting || input.disabled) return;
    input.value = "";
    addUser(msg);
    if (!api) { note(() => L("demo")); return; }
    if (!sessionId) {
      starting = true; refresh();
      let r: CoderStart | null = null;
      try { r = await api.start(agent, mode); } catch (e) { r = { ok: false, error: String(e instanceof Error ? e.message : e) }; }
      starting = false;
      if (!r?.ok || !r.sessionId) { note(r?.error ? () => tx(r.error) : () => L("startFailed"), true); refresh(); return; }
      sessionId = r.sessionId;
    }
    busy = true; refresh();
    api.send(sessionId, msg);
  }
  form.onsubmit = (e) => { e.preventDefault(); submit(input.value); };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(input.value); } };
  stop.onclick = () => { if (api && sessionId) api.cancel(sessionId); };

  // ---- démonstration (hors de l'app)
  function demo() {
    agents = [{ id: "claude", label: "Claude Code", available: true, loginHint: "claude auth login" }, { id: "codex", label: "Codex", available: false, loginHint: "codex login" }];
    availKnown = true;
    if (!agent) agent = "claude";
    const en = pageLang() === "en";
    addUser(en ? "Make Floppy more discreet" : "Rends Floppy plus discret");
    addText(en
      ? "I'm looking at your settings. To be more **discreet**, I suggest:\n\n- lowering free listening to `5` seconds\n- hiding the avatar after `2` minutes\n\nI'm changing the `floppy.yml` file right away."
      : "Je regarde tes réglages. Pour être plus **discret**, je propose :\n\n- baisser l'écoute libre à `5` secondes\n- masquer l'avatar après `2` minutes\n\nJe change tout de suite le fichier `floppy.yml`.");
    upsertTool({ type: "tool", id: "t1", name: "Read", input: { file_path: "floppy.yml" }, status: "done", output: "settings:\n  ecoute_libre: 12\n  masquer_apres: 15" });
    upsertTool({ type: "tool", id: "t2", name: "Grep", input: { pattern: "masquer_apres" }, status: "running" });
    addPermission({
      type: "permission", id: "p1", tool: "Edit", description: en ? "Edit floppy.yml" : "Modifier floppy.yml",
      diff: { path: "floppy.yml", before: "settings:\n  voix: femme\n  ecoute_libre: 12\n  masquer_apres: 15\n  avatar_visible: true", after: "settings:\n  voix: femme\n  ecoute_libre: 5\n  masquer_apres: 2\n  avatar_visible: true" },
    }, () => {}, false);
    refresh();
  }

  applyOpen();
  applyTexts();
  log.append(intro());
  refresh();
  // Langue de l'interface changée (la fenêtre des réglages met à jour <html lang>) : tout le panneau suit.
  new MutationObserver(() => {
    applyTexts();
    if (empty) log.replaceChildren(intro());
    for (const fn of relabel) fn();
    refresh();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  if (api) checkAvailable(); else demo();
  window.addEventListener("beforeunload", () => { if (api && sessionId) api.close(sessionId); });
}
