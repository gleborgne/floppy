// Fenêtre « Conversation » : le fil de ce que l'utilisateur dit et de ce que Floppy répond, avec un champ pour écrire.
// Propriétaire de la fenêtre, de sa place par rapport à l'avatar et du journal (en mémoire seulement, jamais sur disque).
// La page de l'avatar reste le seul corps relié au noyau : elle relaie ce qu'elle reçoit (`relay`), et ce que l'utilisateur
// écrit, accorde ou choisit ici repart par elle (`submit`, `answerApproval`, `answerChoice`).
import { screen, shell } from "electron";
import type { BrowserWindow } from "electron";
import { renderMarkdown } from "./markdown.ts";
import { safeWindow, bringToFront } from "./windows.ts";
import { pageFile } from "./ui.ts";
import { chatSpot } from "./placement.ts";
import type { Area } from "./placement.ts";
import { cleanChatEvent, createChatLog, isLongReply } from "./chat-log.ts";
import type { ChatDelta } from "./chat-log.ts";
import type { Texts } from "./app-texts.ts";
import type { KernelProcess } from "./kernel-process.ts";
import type { AvatarWindow } from "./avatar.ts";
import type { VoiceControls } from "./voice-controls.ts";

/** Taille voulue (la hauteur se réduit jusqu'à 320 px si la place manque) et hauteur de la tête de l'avatar (voir avatar.ts). */
const CHAT_SIZE = { width: 420, height: 520, minHeight: 320 };
const AVATAR_HEAD = 230;
/** Écart toléré entre la place posée par l'app et la place lue : au-delà, c'est l'utilisateur qui a déplacé la fenêtre. */
const MOVED_TOLERANCE = 3;
const LINK_PROTOCOLS = ["https:", "http:", "mailto:"];

export interface ChatWindowDeps {
  texts: Texts;
  refreshTray(): void;
  kernel(): Pick<KernelProcess, "kernel" | "hasBodyPort">;
  avatar(): Pick<AvatarWindow, "win" | "winReady" | "activity">;
  voice(): Pick<VoiceControls, "setMuted">;
}

export interface ChatWindow {
  win(): BrowserWindow | null;
  /** Ouverture voulue par l'utilisateur : la fenêtre passe devant et le champ de saisie prend le focus. */
  open(): BrowserWindow;
  /** Ouverture venue de Floppy (choix, longue réponse) : visible, sans prendre le focus. */
  show(): void;
  /** Langue de l'interface changée : titre et page suivent tout de suite. */
  setLang(): void;
  /** Ce que la page de l'avatar relaie du noyau (refusé de toute autre page). */
  relay(e: { sender: unknown }, raw: unknown): boolean;
  /** Bouton de la bulle : la page de l'avatar demande à ouvrir la conversation. */
  openFromAvatar(e: { sender: unknown }): boolean;
  /** Texte écrit dans la fenêtre : mêmes vérifications qu'une demande venue du clavier, puis jusqu'au noyau par l'avatar. */
  submit(e: { sender: unknown }, raw: unknown): boolean;
  answerApproval(e: { sender: unknown }, id: unknown, ok: unknown): boolean;
  answerChoice(e: { sender: unknown }, id: unknown, option: unknown): boolean;
  /** Lien cliqué dans une réponse : navigateur externe, adresses http, https et mailto seulement. */
  link(e: { sender: unknown }, url: unknown): boolean;
  close(e: { sender: unknown }): boolean;
}

export function createChatWindow(deps: ChatWindowDeps): ChatWindow {
  const { texts } = deps;
  const { T } = texts;
  const log = createChatLog({ render: (markdown) => renderMarkdown(markdown), now: () => Date.now() });
  let win: BrowserWindow | null = null;
  let loaded = false;                       // la page a reçu le journal : elle reçoit ensuite les changements
  let ready = false;                        // la fenêtre peut être montrée (ready-to-show)
  let pending: "quiet" | "front" | null = null;   // comment la montrer quand elle sera prête
  let lastSet: Area | null = null;          // dernière place posée par l'app
  let manual = false;                       // l'utilisateur l'a déplacée ou redimensionnée : elle reste où il l'a mise
  let announced = false;                    // dernier état dit à l'avatar (la bulle se cache quand la fenêtre est visible)
  let followed: BrowserWindow | null = null;

  const alive = (): boolean => !!win && !win.isDestroyed();
  const avatarWin = (): BrowserWindow | null => { const w = deps.avatar().win(); return w && !w.isDestroyed() ? w : null; };
  const fromChat = (e: { sender: unknown }): boolean => alive() && e.sender === win!.webContents;
  const fromAvatar = (e: { sender: unknown }): boolean => { const w = avatarWin(); return !!w && e.sender === w.webContents; };

  // ------------------------------------------------------------------ place
  function place(): void {
    const av = avatarWin();
    if (!av || !alive()) return;
    const b = av.getBounds();
    win!.setBounds(chatSpot({ avatar: b, work: screen.getDisplayMatching(b).workArea, head: AVATAR_HEAD, size: CHAT_SIZE }));
    lastSet = win!.getBounds();
  }
  const moved = (a: Area, b: Area): boolean => [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height].some((d) => Math.abs(d) > MOVED_TOLERANCE);
  /** L'avatar a bougé (glissé, replacé) : la conversation le suit, sauf si l'utilisateur l'a placée lui-même. */
  function follow(): void {
    if (alive() && !placedByUser()) place();
  }
  /** Vrai dès que la fenêtre n'est plus là où l'app l'a posée : lu à chaque replacement (avatar qui bouge, réouverture). */
  function placedByUser(): boolean {
    if (!manual && alive() && lastSet && moved(win!.getBounds(), lastSet)) manual = true;
    return manual;
  }

  // ------------------------------------------------------------------ visible ou non : la bulle de l'avatar s'efface
  function syncOpen(): void {
    const on = alive() && ready && win!.isVisible() && !win!.isMinimized();
    if (on === announced) return;
    announced = on;
    const av = avatarWin();
    if (av && deps.avatar().winReady()) av.webContents.send("chat-open", on);
  }

  function resync(): void { announced = false; syncOpen(); }

  function reveal(mode: "quiet" | "front"): void {
    if (!alive()) return;
    if (!ready) { pending = mode === "front" || pending === "front" ? "front" : "quiet"; return; }
    if (mode === "front") { bringToFront(win); win!.webContents.send("chat:focus"); }
    else if (!win!.isMinimized()) { win!.showInactive(); win!.moveTop(); }
    syncOpen();
  }

  function create(mode: "quiet" | "front"): BrowserWindow {
    const w = safeWindow({ size: { width: CHAT_SIZE.width, height: CHAT_SIZE.height, minWidth: 340, minHeight: CHAT_SIZE.minHeight }, title: T("chatTitle"), preload: "preload-chat.cjs" });
    win = w; loaded = false; ready = false; manual = false; pending = mode;
    place();
    w.loadFile(pageFile("chat"));
    w.webContents.on("did-start-loading", () => { loaded = false; });
    w.webContents.on("did-finish-load", () => { loaded = true; w.webContents.send("chat:init", { lang: texts.lang(), entries: log.entries() }); });
    w.once("ready-to-show", () => { ready = true; const how = pending ?? "quiet"; pending = null; reveal(how); });
    w.on("show", syncOpen); w.on("hide", syncOpen); w.on("minimize", syncOpen); w.on("restore", syncOpen);
    const av = avatarWin();
    av?.on("move", follow);
    // La page de l'avatar se recharge (panne de rendu) : elle a oublié que la conversation est ouverte, on le lui redit.
    av?.webContents.on("did-finish-load", resync);
    followed = av;
    w.on("closed", () => {
      win = null; loaded = false; ready = false; manual = false; lastSet = null;
      followed?.removeListener("move", follow);
      if (followed && !followed.isDestroyed()) followed.webContents.removeListener("did-finish-load", resync);
      followed = null;
      syncOpen();
      deps.refreshTray();
    });
    return w;
  }

  function open(): BrowserWindow {
    if (!alive()) return create("front");
    if (!placedByUser()) place();
    reveal("front");
    return win!;
  }
  function show(): void {
    if (!alive()) create("quiet");
    else { if (!placedByUser()) place(); reveal("quiet"); }
  }

  function push(delta: ChatDelta): void {
    if (alive() && loaded && (delta.changed.length || delta.removed.length)) win!.webContents.send("chat:change", delta);
  }

  // ------------------------------------------------------------------ du noyau (par l'avatar) vers la fenêtre
  function relay(e: { sender: unknown }, raw: unknown): boolean {
    if (!fromAvatar(e)) return false;
    const event = cleanChatEvent(raw);
    if (!event) return false;
    const delta = log.apply(event);
    push(delta);
    // Floppy ouvre la conversation, sans voler le focus : une liste à choisir, ou une réponse trop longue pour la bulle.
    if (event.type === "choice.request") show();
    else if (event.type === "reply.done") {
      const finished = delta.changed.find((c) => c.kind === "reply" && c.done);
      if (finished?.kind === "reply" && isLongReply(finished.text)) show();
    }
    return true;
  }

  // ------------------------------------------------------------------ de la fenêtre (par l'avatar) vers le noyau
  function submit(e: { sender: unknown }, raw: unknown): boolean {
    const av = avatarWin();
    if (!fromChat(e) || !av) return false;
    if (typeof raw !== "string" || !raw.trim() || raw.length > 10000 || !deps.kernel().kernel() || !deps.kernel().hasBodyPort() || !deps.avatar().winReady()) return false;
    deps.avatar().activity();
    deps.voice().setMuted(false);
    av.webContents.send("text-request", raw.trim());
    deps.refreshTray();
    return true;
  }
  function answerApproval(e: { sender: unknown }, id: unknown, ok: unknown): boolean {
    const av = avatarWin();
    if (!fromChat(e) || !av || typeof id !== "string") return false;
    if (!log.entries().some((x) => x.kind === "approval" && x.key === id && x.outcome === "pending")) return false;
    av.webContents.send("chat-approval", { id, ok: ok === true });
    return true;
  }
  function answerChoice(e: { sender: unknown }, id: unknown, option: unknown): boolean {
    const av = avatarWin();
    if (!fromChat(e) || !av || typeof id !== "string" || typeof option !== "string") return false;
    const entry = log.entries().find((x) => x.kind === "choice" && x.key === id && !x.closed);
    if (entry?.kind !== "choice" || !entry.options.some((o) => o.id === option)) return false;
    av.webContents.send("chat-choice", { id, option });
    return true;
  }

  function link(e: { sender: unknown }, url: unknown): boolean {
    if (!fromChat(e)) return false;
    try {
      const u = new URL(String(url));
      if (!LINK_PROTOCOLS.includes(u.protocol)) return false;
      void Promise.resolve(shell.openExternal(u.toString())).catch(() => {});
      return true;
    } catch { return false; }   // adresse invalide : rien
  }
  function close(e: { sender: unknown }): boolean {
    if (!fromChat(e)) return false;
    win!.close();
    return true;
  }
  function openFromAvatar(e: { sender: unknown }): boolean {
    if (!fromAvatar(e)) return false;
    open();
    return true;
  }
  function setLang(): void {
    if (!alive()) return;
    win!.setTitle(T("chatTitle"));
    win!.webContents.send("chat:lang", texts.lang());
  }

  return { win: () => win, open, show, setLang, relay, openFromAvatar, submit, answerApproval, answerChoice, link, close };
}
