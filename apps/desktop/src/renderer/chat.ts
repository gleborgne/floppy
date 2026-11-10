// Fenêtre « Conversation » : le fil de ce que l'utilisateur dit et de ce que Floppy répond, et un champ pour écrire.
// Le processus principal tient le journal (en mémoire) : la page reçoit tout le journal au chargement, puis les changements.
// Une réponse s'écrit en texte brut pendant qu'elle arrive ; terminée, elle arrive en HTML déjà rendu et nettoyé par le
// processus principal (voir markdown.ts) : c'est le seul `innerHTML` de la page, comme dans documents.ts.
// Éléments de la page : ils existent dans chat.html (pas de repli).
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
type Lang = "fr" | "en";
const TXT: Record<Lang, Record<string, string>> = {
  fr: {
    log: "Conversation", empty: "Rien pour l'instant. Écris à Floppy ou parle-lui.", label: "Écrire à Floppy", placeholder: "Écrire à Floppy…", send: "Envoyer",
    hint: "Entrée pour envoyer · Maj+Entrée : nouvelle ligne · Échap pour fermer · 1 à 9 pour choisir dans une liste (champ vide ou hors du champ)",
    notReady: "Floppy n'est pas encore prêt. Réessaie dans un instant.",
    you: "Toi", info: "Info", important: "Important", error: "Erreur", ask: "Ton accord ?", yes: "Oui", no: "Non",
    approved: "Accordé", refused: "Refusé ou expiré", picked: "Choix :", noChoice: "Aucun choix",
  },
  en: {
    log: "Conversation", empty: "Nothing yet. Write to Floppy or talk to it.", label: "Write to Floppy", placeholder: "Write to Floppy…", send: "Send",
    hint: "Enter to send · Shift+Enter for a new line · Escape to close · 1 to 9 to pick from a list (empty field or outside the field)",
    notReady: "Floppy is not ready yet. Try again in a moment.",
    you: "You", info: "Info", important: "Important", error: "Error", ask: "Your approval?", yes: "Yes", no: "No",
    approved: "Approved", refused: "Refused or expired", picked: "Chosen:", noChoice: "No choice",
  },
};
let lang: Lang = "fr";
const t = (k: string): string => (TXT[lang] ?? TXT.fr)[k] ?? k;

const log = el("log");
const prompt = el<HTMLTextAreaElement>("prompt");
const form = el<HTMLFormElement>("request");
const send = el<HTMLButtonElement>("send");
const error = el("error");
const entries = new Map<number, ChatEntry>();      // dans l'ordre d'arrivée
const nodes = new Map<number, HTMLElement>();
const answered = new Set<string>();                // accords et choix déjà envoyés (un seul clic compte)
let sending = false;
let stick = true;                                  // le fil suit le bas, sauf si l'utilisateur est remonté
let lastAuto = 0;

// ------------------------------------------------------------------ fabrication des éléments
function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
/** Barre du temps restant : se vide jusqu'à l'expiration de la demande. */
function ttlBar(e: { ttl_s: number; at: number }): HTMLElement {
  const bar = make("div", "ttl");
  const total = e.ttl_s * 1000;
  const left = Math.max(0, total - (Date.now() - e.at));
  bar.animate?.([{ transform: `scaleX(${left / total})` }, { transform: "scaleX(0)" }], { duration: left, fill: "forwards" });
  return bar;
}
function fillReply(body: HTMLElement, e: Extract<ChatEntry, { kind: "reply" }>): void {
  if (e.done) { body.className = "body md"; body.innerHTML = e.html; }
  else { body.className = "body stream"; body.textContent = e.text.trim(); }
}

function pick(e: Extract<ChatEntry, { kind: "choice" }>, option: ChatOption): void {
  if (answered.has(e.key)) return;
  answered.add(e.key);
  nodes.get(e.id)?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  window.floppyChat.answerChoice(e.key, option.id);
}

function build(e: ChatEntry): HTMLElement {
  switch (e.kind) {
    case "you": {
      const n = make("div", "msg you");
      n.append(make("b", "", t("you")), make("span", "", e.text));
      return n;
    }
    case "reply": {
      const n = make("div", "msg reply");
      const body = make("div", "body");
      fillReply(body, e);
      n.append(body);
      return n;
    }
    case "info": {
      const n = make("div", "card info");
      n.append(make("h3", "", e.title || t(e.important ? "important" : "info")), make("p", "", e.text));
      return n;
    }
    case "error": {
      const n = make("div", "card error");
      n.append(make("h3", "", t("error")), make("p", "", e.text));
      return n;
    }
    case "approval": {
      const n = make("div", "card ask");
      n.append(make("h3", "", t("ask")), make("p", "", e.summary));
      if (e.outcome === "pending") {
        const row = make("div", "row");
        const answer = (ok: boolean) => () => {
          if (answered.has(e.key)) return;
          answered.add(e.key);
          row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
          window.floppyChat.answerApproval(e.key, ok);
        };
        const yes = make("button", "yes", t("yes")); yes.type = "button"; yes.onclick = answer(true);
        const no = make("button", "", t("no")); no.type = "button"; no.onclick = answer(false);
        row.append(yes, no);
        n.append(row, ttlBar(e));
      } else n.append(make("div", `outcome ${e.outcome}`, t(e.outcome === "yes" ? "approved" : "refused")));
      return n;
    }
    case "choice": {
      const n = make("div", "card pick");
      n.append(make("h3", "", e.title));
      if (!e.closed) {
        const list = make("div", "opts");
        e.options.forEach((o, i) => {
          const b = make("button", "opt"); b.type = "button";
          const text = make("span", "t"); text.append(make("b", "", o.label));
          if (o.detail) text.append(make("span", "", o.detail));
          b.append(make("span", "n", i < 9 ? String(i + 1) : ""), text);
          b.onclick = () => pick(e, o);
          list.append(b);
        });
        n.append(list, ttlBar(e));
      } else {
        const chosen = e.options.find((o) => o.id === e.picked);
        n.append(make("div", "outcome", chosen ? `${t("picked")} ${chosen.label}` : t("noChoice")));
      }
      return n;
    }
  }
}

// ------------------------------------------------------------------ le fil
function scrollDown(): void {
  if (!stick) return;
  log.scrollTop = log.scrollHeight;
  lastAuto = log.scrollTop;
}
log.addEventListener("scroll", () => {
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 24) stick = true;       // en bas : il suit
  else if (log.scrollTop < lastAuto - 4) stick = false;                             // remonté à la main : on le laisse
});
function showEmpty(): void { el("empty").hidden = entries.size > 0; }

function upsert(e: ChatEntry): void {
  entries.set(e.id, e);
  const old = nodes.get(e.id);
  if (e.kind === "reply" && old) { fillReply(old.querySelector<HTMLElement>(".body")!, e); return; }
  const n = build(e);
  if (old) old.replaceWith(n); else log.append(n);
  nodes.set(e.id, n);
}
function apply(delta: ChatDelta): void {
  for (const id of delta.removed) { nodes.get(id)?.remove(); nodes.delete(id); entries.delete(id); }
  for (const e of delta.changed) upsert(e);
  showEmpty();
  scrollDown();
}
/** Le journal entier (au chargement) : tout est refait, et le fil se place en bas. */
function init(data: ChatInit): void {
  setLang(data.lang);
  log.replaceChildren(); entries.clear(); nodes.clear();
  stick = true;
  for (const e of data.entries) upsert(e);
  showEmpty();
  scrollDown();
}

// ------------------------------------------------------------------ textes et langue
function applyTexts(): void {
  document.documentElement.lang = lang;
  log.setAttribute("aria-label", t("log"));
  el("empty").textContent = t("empty");
  prompt.setAttribute("aria-label", t("label"));
  prompt.placeholder = t("placeholder");
  send.textContent = t("send");
  el("hint").textContent = t("hint");
  if (!error.hidden) error.textContent = t("notReady");
}
function setLang(value: string): void {
  const next: Lang = value === "en" ? "en" : "fr";
  if (next === lang && document.documentElement.lang === next) return;
  lang = next;
  applyTexts();
  for (const e of entries.values()) { const old = nodes.get(e.id); if (!old) continue; const n = build(e); old.replaceWith(n); nodes.set(e.id, n); }
}

// ------------------------------------------------------------------ écrire, répondre, fermer
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending || !prompt.value.trim()) return;
  sending = true; send.disabled = true; error.hidden = true;
  try {
    if (await window.floppyChat.submit(prompt.value)) { prompt.value = ""; stick = true; scrollDown(); prompt.focus(); }
    else { error.textContent = t("notReady"); error.hidden = false; }   // le brouillon reste
  } catch { error.textContent = t("notReady"); error.hidden = false; }
  finally { sending = false; send.disabled = false; }
});

/** Le choix en attente le plus récent (celui que les touches 1 à 9 visent). */
function pendingChoice(): Extract<ChatEntry, { kind: "choice" }> | undefined {
  for (const e of [...entries.values()].reverse()) if (e.kind === "choice" && !e.closed && !answered.has(e.key)) return e;
  return undefined;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!e.isComposing) window.floppyChat.close(); return; }
  if (e.target === prompt && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); return; }
  // Touches 1 à 9 : choisir la ligne correspondante, sauf quand on est en train d'écrire (champ actif avec du texte).
  if (/^[1-9]$/.test(e.key) && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    if (document.activeElement === prompt && prompt.value !== "") return;
    const choice = pendingChoice();
    const option = choice?.options[Number(e.key) - 1];
    if (choice && option) { e.preventDefault(); pick(choice, option); }
  }
});
// Les liens ne naviguent jamais dans la fenêtre : le processus principal vérifie et ouvre le navigateur.
log.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a) return;
  e.preventDefault();
  window.floppyChat.link(a.getAttribute("href") ?? "");
});

window.floppyChat.onInit(init);
window.floppyChat.onChange(apply);
window.floppyChat.onLang(setLang);
window.floppyChat.onFocus(() => prompt.focus());
applyTexts();
showEmpty();

// Module (pas de nom global partagé entre les pages).
export {};
