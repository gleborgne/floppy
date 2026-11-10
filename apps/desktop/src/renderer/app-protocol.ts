// Protocole v0 avec le noyau (voir packages/protocol) : messages reçus, outils de l'avatar, connexion du port,
// messages de la fenêtre (réglages d'affichage, raccourcis, texte tapé, documents).
// Propriétaire de la session (état, muet, parler, dictée, accords) : les autres modules la lisent seulement.
import type { BodyToKernel, BodyToolDecl, Capability, KernelToBody } from "@floppy/protocol";
import { $, errText, type CardEl } from "./app-dom.ts";
import type { Bubble } from "./app-bubble.ts";
import type { Face } from "./app-face.ts";
import type { Life } from "./app-life.ts";
import type { Mic } from "./app-mic.ts";
import type { Playback } from "./app-playback.ts";
import type { Link, Session } from "./app-session.ts";
import type { Texts } from "./app-texts.ts";

/** Demande d'outil du noyau (tool.call) : le protocole type `args` en vrac, l'avatar lit les siens. */
type ToolCallMsg = Omit<Extract<KernelToBody, { type: "tool.call" }>, "args"> & {
  args?: { titre?: unknown; lignes?: string[]; coin?: string; ecran?: unknown; cible?: string };
};
/** Message du noyau reçu par l'avatar : les types du protocole (aucun n'est ignoré par le `switch`). */
export type KernelMsg = Exclude<KernelToBody, { type: "tool.call" }> | ToolCallMsg;

const TOOLS: BodyToolDecl[] = [
  // Ouvrir une page web : c'est le plugin « browser » (Réglages → Connecteurs), plus un outil de l'avatar.
  { name: "afficher_carte", description: "Affiche une carte à l'écran (titre et quelques lignes), pour une information longue. La réponse reste dite à voix haute.",
    inputSchema: { type: "object", properties: { titre: { type: "string" }, lignes: { type: "array", items: { type: "string" } } }, required: ["titre"] }, level: "read" },
  { name: "placer_avatar", description: "Déplace l'avatar de Floppy à l'écran (par ex. « remets-toi en place », « va en haut à gauche », « va sur l'écran 2 », « mets-toi sur ma fenêtre »). Sans précision : en bas à droite de l'écran principal, sa place habituelle.",
    inputSchema: { type: "object", properties: {
      coin: { type: "string", enum: ["bas_droite", "bas_gauche", "haut_droite", "haut_gauche", "centre"], description: "Où dans la zone. Par défaut bas_droite." },
      ecran: { type: "integer", minimum: 1, description: "Numéro d'écran : 1 = principal, puis de gauche à droite." },
      cible: { type: "string", enum: ["ecran", "fenetre"], description: "fenetre : dans la fenêtre active (celle où l'utilisateur travaille) au lieu de tout l'écran." },
    } }, level: "read" },
];
/**
 * Frontière avec l'outil `placer_avatar` : ses arguments et valeurs restent en français jusqu'au lot des outils ;
 * la fenêtre de l'app (IPC `avatar:place`) reçoit déjà les noms anglais. Un lot suivant supprime cette table.
 */
const CORNER_OF_TOOL: Record<string, string> = { bas_droite: "bottom_right", bas_gauche: "bottom_left", haut_droite: "top_right", haut_gauche: "top_left", centre: "center" };

const CAPABILITIES: Capability[] = ["voice", "display", "emotion", "approval", "panel", "document", "speech_timing"];

export interface ProtocolDeps {
  host?: FloppyHostApi;
  texts: Pick<Texts, "S" | "said" | "setAssistantLang" | "setLang" | "setTalkKeys">;
  face: Face;
  /** Charge l'avatar demandé par l'app (message display). */
  loadAvatar(rawId: unknown, url: unknown): Promise<void>;
  life: Pick<Life, "touch" | "kernelEmotion" | "lookAtPoint">;
  bubble: Bubble;
  playback: Playback;
  mic: Pick<Mic, "start">;
  /** Écrite ici seulement. */
  session: Session;
  /** Le port n'est attaché qu'ici. */
  link: Link;
}

export function createProtocol(deps: ProtocolDeps) {
  const { host, texts, face, loadAvatar, life, bubble, playback, mic, session, link } = deps;
  const { approvals } = session;
  const send = (msg: BodyToKernel): void => link.send(msg);

  $("stopListening")?.addEventListener("click", () => {
    session.muted = false;
    if (session.pttOn) send({ type: "ptt", on: false });
    session.pttOn = false;
    send({ type: "listen.stop" });
  });

  async function onToolCall(m: ToolCallMsg): Promise<void> {
    try {
      if (m.name === "afficher_carte") {
        bubble.card("info", String(m.args?.titre ?? ""), (m.args?.lignes ?? []).join("\n"));
        send({ type: "tool.result", callId: m.callId, ok: true, text: texts.S("cardShown") });
      } else if (m.name === "placer_avatar" && host?.place) {
        // Réponse de l'app : { ok, text: { fr, en } } (ou une phrase, version plus ancienne).
        const a = m.args;
        const r = await host.place({ corner: CORNER_OF_TOOL[a?.coin ?? ""] ?? a?.coin, screen: a?.ecran, target: a?.cible === "fenetre" ? "window" : "screen" });
        const ok = r && typeof r === "object" && "ok" in r ? r.ok !== false : true;
        send({ type: "tool.result", callId: m.callId, ok, text: texts.said(r && typeof r === "object" && "ok" in r ? r.text : r) });
      } else send({ type: "tool.result", callId: m.callId, ok: false, text: texts.S("unknownTool")(m.name) });
    } catch (e) {
      send({ type: "tool.result", callId: m.callId, ok: false, text: errText(e) });
    }
  }

  function onMessage(m: KernelMsg): void {
    switch (m.type) {
      case "welcome":
        if (typeof m.assistant?.language === "string") texts.setAssistantLang(m.assistant.language.slice(0, 2).toLowerCase());
        mic.start();
        break;
      case "state":
        session.state = m.state;
        if (m.state !== "idle") life.touch();
        face.setState(m.state);
        face.setAttention(approvals.size ? "approval" : m.state);
        host?.setState(m.state);
        if (m.state === "listening" || m.state === "thinking") { session.pttOn = session.pttOn && m.state === "listening"; }
        bubble.showListening(m.state === "listening");
        // De retour au repos : la conversation s'efface au bout de 10 s (sauf demande d'accord en cours).
        // Rien n'a été dit (seulement « Je t'écoute… ») : elle part tout de suite.
        if (m.state === "idle" || m.state === "sleep") bubble.hideSoon(bubble.isEmpty() ? 600 : 10000);
        else bubble.cancelHide();
        break;
      case "emotion":
        if (m.nextAudio) { playback.markEmotion({ emotion: m.emotion, intensity: m.intensity, ms: m.ms }); break; }
        life.kernelEmotion(m.emotion, m.intensity, m.ms);
        break;
      case "speech.gesture":
        playback.markGesture({ intent: m.intent, intensity: m.intensity });
        break;
      case "mood": face.setMood(m.valence, m.energy); break;
      case "cue":
        face.cue(m.cue);
        if (m.cue === "wake") bubble.woke();
        break;
      case "transcript": bubble.transcript(m.text); break;
      case "dictation": host?.dictation?.({ del: m.del, ins: m.ins }); break; // tapé dans la fenêtre active, pas de bulle
      case "reply.delta": bubble.replyDelta(m.text); break;
      case "reply.done": bubble.replyDone(m.text); break;
      case "interrupt": playback.stop(); break;
      case "duck": playback.duck(!!m.on); break;
      case "approval.request": {
        host?.activity("approval");
        const el = bubble.card("ask", { key: "ask" }, m.summary, [
          { label: { key: "yes" }, cls: "yes", onClick: () => send({ type: "approval.response", id: m.id, ok: true }) },
          { label: { key: "no" }, onClick: () => send({ type: "approval.response", id: m.id, ok: false }) },
        ]);
        const bar = document.createElement("div");
        bar.className = "ttl";
        bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: m.ttl_s * 1000, fill: "forwards" });
        el.append(bar);
        approvals.set(m.id, el);
        face.setAttention("approval");
        break;
      }
      case "approval.closed": {
        approvals.get(m.id)?.remove();
        approvals.delete(m.id);
        face.setAttention(approvals.size ? "approval" : session.state);
        if (!approvals.size) host?.approvalClosed();
        if (!bubble.hasCards()) bubble.hideSoon(4000);
        break;
      }
      case "tool.call": onToolCall(m); break;
      case "card": bubble.card("info", m.title, m.lines.join("\n")); break;
      case "panel": host?.openPanel?.(m); break;
      case "document": host?.openDocument?.(m); break;
      case "documents": host?.updateDocuments?.(m.entries); break;
      case "notify": bubble.card("info", { key: m.important ? "important" : "info" }, m.text); bubble.hideSoon(); break;
      case "error": bubble.card("error", { key: "error" }, m.text); break;
    }
  }

  function connect(p: MessagePort): void {
    const old = link.port;
    if (old) { old.onmessage = null; playback.stop(); }
    old?.close();
    link.attach(p);
    // Nouvelle connexion : les anciennes demandes d'accord n'existent plus côté noyau. On retire les cartes
    // et on prévient l'app (sinon le masquage automatique reste bloqué).
    if (approvals.size) {
      for (const el of approvals.values()) el.remove();
      approvals.clear();
      host?.approvalClosed();
    }
    p.onmessage = (e) => {
      const d = e.data;
      if (d?.j) onMessage(d.j);
      else if (d?.a) playback.playChunk(d.a);
    };
    p.start();
    send({ type: "hello", id: "avatar", name: "Avatar (bureau)", version: "0.1.0", capabilities: CAPABILITIES, tools: TOOLS });
  }

  /** Messages de la fenêtre (app principale) : port du noyau, réglages d'affichage, raccourcis, texte tapé, documents. */
  function windowMessage(e: MessageEvent): void {
    if (e.data === "floppy:body-port" && e.ports[0]) connect(e.ports[0]);
    const disp = e.data?.floppyDisplay;
    if (disp) {
      if (typeof disp.shortcuts?.talk === "string") texts.setTalkKeys(disp.shortcuts.talk);
      if (typeof disp.lang === "string") texts.setLang(disp.lang);
      if (typeof disp.avatar === "string") void loadAvatar(disp.avatar, disp.avatarUrl);
      bubble.setEnabled(disp.bubble !== false);
    }
    const docOpen = e.data?.floppyDocumentOpen;
    if (typeof docOpen === "string") send({ type: "document.open", id: docOpen });
    const docDel = e.data?.floppyDocumentDelete;
    if (docDel && typeof docDel.id === "string") send({ type: "document.delete", id: docDel.id, ...(docDel.current ? { current: docDel.current } : {}) });
    const cur = e.data?.floppyCursor;
    if (cur) life.lookAtPoint(cur.x, cur.y);
    const sc = e.data?.floppyShortcut;
    const request = e.data?.floppyTextRequest;
    if (typeof request === "string" && request.trim()) { session.muted = false; playback.stop(); send({ type: "text", text: request }); }
    if (sc === "ptt-on" || sc === "ptt-off") { session.pttOn = sc === "ptt-on"; playback.stop(); send({ type: "ptt", on: session.pttOn }); }
    if (sc === "dictate-on" || sc === "dictate-off") { session.dictating = sc === "dictate-on"; if (session.dictating) playback.stop(); send({ type: "dictate", on: session.dictating }); }
    if (sc === "mute-on" || sc === "mute-off") { session.muted = sc === "mute-on"; send({ type: "mute", on: session.muted }); }
  }
  return { onMessage, connect, windowMessage };
}
export type Protocol = ReturnType<typeof createProtocol>;
