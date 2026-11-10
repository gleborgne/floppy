// Bulle de conversation, cartes (infos, erreurs, demandes d'accord) et indicateur d'écoute.
import { $, type CardEl } from "./app-dom.ts";
import type { SessionView } from "./app-session.ts";
import type { TextKey, Texts } from "./app-texts.ts";

/** Texte d'une carte : un texte, ou une clé de TEXTS (suit la langue de l'interface). */
export type CardText = string | { key: string };
export interface CardButton { label: CardText; cls?: string; onClick: () => void }

export interface BubbleDeps {
  texts: Pick<Texts, "L">;
  /** Lecture seule : on ne cache jamais la conversation tant que Floppy parle, écoute ou réfléchit. */
  session: Pick<SessionView, "state">;
}

/** Propriétaire de la bulle : affichage voulu, minuteur de masquage, texte de la réponse, indicateur d'écoute. */
export function createBubble(deps: BubbleDeps) {
  const { texts, session } = deps;
  const L = texts.L;
  let bubbleOn = true;
  let hideTimer = 0;
  let replyText = "";
  const atRest = () => session.state === "idle" || session.state === "sleep";
  function showBubble() {
    if (!bubbleOn && !$("cards").children.length) return; // sans bulle, les cartes (accord, erreur) restent visibles
    clearTimeout(hideTimer);
    $("bubble").classList.remove("hide");
    const sc = $("scroll");
    requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
  }
  function hideBubbleSoon(ms = 9000) {
    clearTimeout(hideTimer);
    // Pas au repos : rien maintenant. Le retour au repos relance le minuteur (10 s).
    if (!atRest()) return;
    hideTimer = setTimeout(() => {
      if (!atRest()) return;
      // Seules les demandes d'accord retiennent la bulle (il faut y répondre). Les infos partent avec elle.
      if ($("cards").querySelector(".card.ask")) return;
      $("cards").querySelectorAll(".card:not(.ask)").forEach((c) => c.remove());
      $("bubble").classList.add("hide");
      setTimeout(() => { if ($("bubble").classList.contains("hide")) { $("you").textContent = ""; $("reply").textContent = ""; } }, 250);
    }, ms);
  }
  // Le noyau décide de la fin de l'écoute ; une transcription seule ne la termine pas.
  let listenShown = false;
  function showListening(on: boolean): void {
    if (on === listenShown) return;
    listenShown = on;
    $("listen").hidden = !on;
    if (on) showBubble();
  }
  /** Il entend son nom : anneau autour du visage + petit saut, puis « Je t'écoute… ». */
  let wokeTimer = 0;
  function woke() {
    const w = $("faceWrap");
    w.classList.remove("woke");
    void w.offsetWidth; // relance l'animation
    w.classList.add("woke");
    clearTimeout(wokeTimer);
    wokeTimer = setTimeout(() => w.classList.remove("woke"), 750);
    if (session.state !== "thinking" && session.state !== "speaking") showListening(true);
  }
  function setYou(text: string): void {
    const you = $("you");
    you.textContent = "";
    const b = document.createElement("b"); b.textContent = L("you");
    you.append(b, document.createTextNode(text));
  }
  /** Une carte. title et les libellés des boutons : un texte, ou une clé de TEXTS (suit la langue de l'interface). */
  function card(kind: string, title: CardText, text: string, buttons?: CardButton[]): CardEl {
    const el: CardEl = document.createElement("div");
    el.className = `card ${kind}`;
    const h = document.createElement("h3");
    const p = document.createElement("p"); p.textContent = text;
    el.append(h, p);
    const btns: [HTMLButtonElement, CardText][] = [];
    if (buttons) {
      const row = document.createElement("div"); row.className = "row";
      for (const b of buttons) {
        const btn = document.createElement("button");
        btn.className = b.cls ?? "";
        btn.onclick = b.onClick;
        btns.push([btn, b.label]);
        row.append(btn);
      }
      el.append(row);
    }
    const txt = (x: CardText): string => (typeof x === "object" ? L(x.key as TextKey) : x);
    el._relabel = () => {
      h.textContent = txt(title);
      for (const [btn, label] of btns) btn.textContent = txt(label);
      if (kind !== "ask") el.title = L("closeTip");
    };
    el._relabel();
    // Info, erreur : clic = fermer. L'expiration ne retire jamais le texte pendant la lecture.
    if (kind !== "ask") {
      const same = [...$("cards").querySelectorAll<CardEl>(`.card.${kind}`)].find((c) => c.textContent === el.textContent);
      if (same) { showBubble(); return same; }
      el.style.cursor = "pointer";
      const close = () => {
        el.remove();
        if ($("cards").children.length) return;
        if (!$("you").textContent && !$("reply").textContent && !listenShown) $("bubble").classList.add("hide");
        else hideBubbleSoon(1500);
      };
      el.addEventListener("click", close);
      setTimeout(() => {
        // Le retour au repos programmera la fermeture de la bulle et de ses cartes.
        if (!atRest()) return;
        close();
      }, 12000);
    }
    $("cards").append(el);
    showBubble();
    return el;
  }
  return {
    show: showBubble,
    hideSoon: hideBubbleSoon,
    /** Annule le masquage programmé (Floppy n'est plus au repos). */
    cancelHide(): void { clearTimeout(hideTimer); },
    hasCards: (): boolean => $("cards").children.length > 0,
    /** Ni phrase de l'utilisateur, ni réponse, ni carte. */
    isEmpty: (): boolean => !$("you").textContent && !$("reply").textContent && !$("cards").children.length,
    /** Réglage « bubble » (message display) : sans bulle, seules les cartes restent visibles. */
    setEnabled(on: boolean): void {
      bubbleOn = on;
      document.body.classList.toggle("nobubble", !bubbleOn);
      if (!bubbleOn && !$("cards").children.length) $("bubble").classList.add("hide");
    },
    showListening,
    listening: (): boolean => listenShown,
    woke,
    /** Ce que l'utilisateur a dit : remplace la phrase affichée et efface la réponse précédente. */
    transcript(text: string): void {
      setYou(text); replyText = ""; $("reply").textContent = "";
      showBubble();
    },
    replyDelta(text: string): void {
      replyText += text; $("reply").textContent = replyText.trim(); showBubble();
    },
    replyDone(text?: string): void {
      if (text) $("reply").textContent = text;
      hideBubbleSoon();
    },
    card,
  };
}
export type Bubble = ReturnType<typeof createBubble>;
