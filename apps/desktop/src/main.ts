// Processus principal de l'app : une seule app = le noyau (utilityProcess) + le corps par défaut (avatar).
// - Lance le noyau, le surveille, le relance s'il s'arrête.
// - Fenêtre de l'avatar : sans cadre, transparente, toujours devant, en bas à droite.
// - Relie l'avatar au noyau par un MessagePort (même protocole que le WebSocket des autres corps).
// - Icône dans la barre des tâches (couleur = état), raccourcis globaux.
import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, utilityProcess, MessageChannelMain, shell, ipcMain, screen, session, dialog, clipboard } from "electron";
import type { UtilityProcess, WebContents } from "electron";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { createWriteStream, mkdirSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { renderMarkdown } from "./markdown.ts";
import { Typer, foregroundRect } from "./typer.ts";
import { TEXTS, keysForOS } from "./main-texts.ts";
import type { Lang, TextKey } from "./main-texts.ts";
import { dotPng, COLORS } from "./tray-icon.ts";
import type { Rgb } from "./tray-icon.ts";
import { safeWindow, bringToFront } from "./windows.ts";
import { avatarSpot } from "./placement.ts";
import type { Area, Bilingual } from "./placement.ts";

/**
 * Message du noyau (utilityProcess) ou demande d'une page : les champs dépendent de `type` et ne sont pas vérifiés
 * à l'exécution (chaque branche valide ce qu'elle lit). `any` assumé : ce protocole n'a pas de type partagé.
 */
interface Msg { type?: string; [key: string]: any }
/** Texte simple, ou { fr, en } venu du noyau. */
type Say = string | Bilingual;
/** Résolution de la réponse du noyau à une demande (la forme dépend de la demande). */
type Reply = (r: any) => void;
interface Display { avatar_visible: boolean; masquer_apres: number; bulle: boolean; toujours_devant: boolean; avatar: string; avatarUrl: string; raccourcis?: Record<string, string>; demarrage_windows?: boolean; [key: string]: unknown }

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..", "..");                     // dossier assistant/
// Config imposée (FLOPPY_CONFIG) ; sinon le noyau lit <répertoire de travail>/floppy.yml (apps/cli/src/boot.ts).
const CONFIG = process.env.FLOPPY_CONFIG ? resolve(process.env.FLOPPY_CONFIG) : null;
// Mode debug d'un plugin : `npm start -- --dev-plugin <dossier>` (répétable). Le noyau le charge activé et le relit
// à chaque sauvegarde (apps/cli/src/boot.ts, variable FLOPPY_DEV_PLUGINS ; le noyau hérite de l'environnement).
const DEV_PLUGINS = (process.argv ?? []).flatMap((a, i, all) => a === "--dev-plugin" && all[i + 1] ? [resolve(all[i + 1]!)] : a.startsWith("--dev-plugin=") ? [resolve(a.slice(13))] : []);
if (DEV_PLUGINS.length) process.env.FLOPPY_DEV_PLUGINS = DEV_PLUGINS.join(delimiter);
const W = 320;
const H = 560;     // taille fixe : la bulle a toute la place au-dessus de la tête (les zones vides laissent passer les clics)

let kernel: UtilityProcess | null = null;
let kernelWantsPort = false;
let win: BrowserWindow | null = null;
let winReady = false;
let tray: Tray | null = null;
let quitting = false;
let currentPorts: MessageChannelMain | null = null;
let state = "idle";
let settingsWin: BrowserWindow | null = null;
let onbWin: BrowserWindow | null = null;               // fenêtre « Bienvenue » (premier lancement)
let lastSettings: Msg | null = null;        // dernier { list, sections, plugins, lang } reçu du noyau
let lastOnb: unknown = null;            // dernier état de l'installation de départ (fenêtre « Bienvenue » et réglages)
let lastItems: { providers: Msg[]; lang: Lang } | null = null;           // derniers { providers, lang } reçus du noyau (éléments : modèles, voix, connecteurs, corps, avatars)
let lang: Lang = "fr";                // langue de l'interface (réglage « langue_interface » du noyau)
let reqSeq = 0;
let crashes: number[] = [];               // heures des dernières pannes du noyau (relance avec une attente qui grandit)
let restarting = false;         // relance demandée (menu, réglage) : pas une panne
let bootFailure: Say | null = null;         // raison d'un démarrage impossible, envoyée par le noyau avant de s'arrêter
// Logos { program } / { handler } des éléments (packages/core/src/logo.ts) : le noyau ne lit pas les icônes du système,
// l'app les lit ici et les remplace par une adresse data: avant d'envoyer la liste à la fenêtre. Clé → adresse, "" (rien) ou attente.
const logoCache = new Map<string, string | Promise<void>>();
function logoKey(l: unknown): string | null {
  if (!l || typeof l !== "object") return null;
  const { program, handler } = l as { program?: unknown; handler?: unknown };
  if (typeof program === "string") return `p:${program}`;
  if (typeof handler === "string") return `h:${handler}`;
  return null;
}
async function systemLogo(key: string): Promise<string> {
  try {
    if (key.startsWith("p:")) {
      const file = key.slice(2);
      if (!existsSync(file)) return "";
      const img = await app.getFileIcon(file, { size: process.platform === "darwin" ? "normal" : "large" });
      return img.isEmpty() ? "" : img.toDataURL();
    }
    // Programme qui ouvre ce protocole (« https » : le navigateur par défaut). Pas de cette lecture sous Linux.
    if (process.platform === "linux") return "";
    const info = await app.getApplicationInfoForProtocol(`${key.slice(2)}://`);
    return info?.icon && !info.icon.isEmpty() ? info.icon.toDataURL() : "";
  } catch { return ""; }
}
/** La liste des éléments pour la fenêtre : logos du système remplacés par leur image (lue une fois, puis gardée). */
function itemsPayload() {
  const providers = (lastItems?.providers ?? []).map((p) => ({ ...p, items: ((p.items ?? []) as Msg[]).map((it) => {
    const key = logoKey(it.logo);
    if (!key) return it;
    const { logo: _, ...rest } = it;
    const v = logoCache.get(key);
    if (typeof v === "string") return v ? { ...rest, logo: v } : rest;
    if (!v) logoCache.set(key, systemLogo(key).then((d) => { logoCache.set(key, d); sendItems(); }));
    return rest;
  }) }));
  return { providers, lang: lastItems?.lang ?? lang };
}
function sendItems() { if (lastItems) settingsWin?.webContents.send("items:update", itemsPayload()); }
const coderSessions = new Set<string>(); // conversations de l'assistant ouvertes depuis la fenêtre des réglages
const pending = new Map<number, Reply>();      // reqId → résolution de la réponse du noyau
// Affichage (réglages du plugin body-electron, reçus du noyau).
let display: Display = { avatar_visible: true, masquer_apres: 0, bulle: true, toujours_devant: true, avatar: "", avatarUrl: "" };
let idleTimer: NodeJS.Timeout | undefined;           // masquage automatique après inactivité
let tempTimer: NodeJS.Timeout | undefined;           // retour au masquage après une apparition temporaire
let tempShown = false;          // fenêtre montrée alors que avatar_visible est faux
let cursorTimer: NodeJS.Timeout | undefined;         // position de la souris envoyée à l'avatar (ses yeux la suivent)
let drag: { cx: number; cy: number; wx: number; wy: number } | null = null;                // déplacement de la fenêtre à la main : { cx, cy, wx, wy } au début
const FREE_LISTEN_MS = 10000;
let pttOn = false;
let dictating = false;          // dictée en cours (Ctrl+Alt+D) : le texte est tapé dans la fenêtre active
let typer: Typer | null = null;
let textWin: BrowserWindow | null = null;             // saisie envoyée sur le corps vocal de l'avatar
let dictWin: BrowserWindow | null = null;             // pilule de dictée (en bas de l'écran, ne prend jamais le focus)
let dictHideTimer: NodeJS.Timeout | undefined;               // frappes clavier de la dictée (chargé à la première dictée)
let muted = false;
const problems = new Map<string, Say>();

// Vérification à côté d'un Floppy déjà lancé : FLOPPY_USER_DATA=<dossier> donne une autre instance (verrou à part).
if (process.env.FLOPPY_USER_DATA) app.setPath("userData", process.env.FLOPPY_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
// Micro et voix sans clic préalable (sinon Chromium crée les AudioContext en pause : avatar sourd et muet).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
process.chdir(ROOT); // les chemins relatifs de floppy.yml partent de la racine du dépôt

// ------------------------------------------------------------------ journal du noyau
// Dossier de données (le même que celui du noyau). L'ancien nom « assistant » est déplacé une fois.
const dataParent = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(process.env.HOME ?? ROOT, ".local", "share");
/**
 * Répertoire de travail, comme le noyau le trouve (packages/core/src/util/home.ts) : FLOPPY_HOME, sinon le dossier
 * choisi (pointeur <dossier par défaut>/home.json), sinon le dossier par défaut.
 */
function homeDir(): string {
  if (process.env.FLOPPY_HOME) return process.env.FLOPPY_HOME;
  const base = join(dataParent, "floppy");
  try {
    const p = JSON.parse(readFileSync(join(base, "home.json"), "utf8"));
    // Déplacement pas encore fait : les données sont encore dans l'ancien dossier (comme le noyau).
    if (typeof p?.moveFrom === "string" && p.moveFrom && existsSync(p.moveFrom)) return p.moveFrom;
    const chosen = p?.home;
    // Dossier choisi absent (disque débranché) : dossier par défaut, comme le noyau.
    if (typeof chosen === "string" && chosen) {
      try { mkdirSync(chosen, { recursive: true }); return chosen; } catch { /* dossier par défaut */ }
    }
  } catch { /* pas de pointeur : dossier par défaut */ }
  if (!existsSync(base) && existsSync(join(dataParent, "assistant"))) {
    try { renameSync(join(dataParent, "assistant"), base); } catch { return join(dataParent, "assistant"); }
  }
  return base;
}
function openLog(dir: string): WriteStream {
  try { mkdirSync(dir, { recursive: true }); } catch { /* disque absent : le noyau choisira le dossier par défaut */ }
  // Au-delà de 20 Mo, le journal devient kernel.1.log (l'ancien est remplacé) : il ne grossit jamais sans limite.
  try { if (statSync(join(dir, "kernel.log")).size > 20 * 1024 * 1024) renameSync(join(dir, "kernel.log"), join(dir, "kernel.1.log")); } catch { /* absent */ }
  const stream = createWriteStream(join(dir, "kernel.log"), { flags: "a" });
  // Journal impossible à ouvrir ou à écrire : l'app continue sans lui (jamais une erreur qui l'arrête).
  stream.on("error", (e: Error) => { try { process.stderr.write(`[app] journal : ${e?.message ?? e}\n`); } catch { /* rien */ } });
  return stream;
}
let logDir = homeDir();
let kernelLog = openLog(logDir);

// ------------------------------------------------------------------ textes du processus principal (fr / en)

// Raccourcis par défaut (les mêmes que plugins/body/electron/src/shortcuts.ts) ; le noyau envoie ceux choisis (display.raccourcis).
const SHORTCUT_DEFAULTS: Record<string, string> = { parler: "Ctrl+Alt+F", ecrire: "Ctrl+Alt+T", dicter: "Ctrl+Alt+D", dormir: "Ctrl+Alt+M", avatar: "Ctrl+Alt+H" };
const shortcuts: Record<string, string> = { ...SHORTCUT_DEFAULTS };
/** Remplace « (Ctrl+Alt+F) » des textes par le raccourci choisi pour cette action ; rien s'il est désactivé. */
const withKeys = (s: string): string => Object.entries(SHORTCUT_DEFAULTS)
  .reduce((acc, [a, def]) => acc.replaceAll(` (${def})`, shortcuts[a] ? ` (${shortcuts[a]})` : ""), s);
const T = (k: TextKey): string => keysForOS(withKeys((TEXTS[lang] ?? TEXTS.fr)[k] ?? TEXTS.fr[k] ?? k));
/** Le même texte dans les deux langues (pour ce qui repart vers le noyau : il choisit la langue de celui qui lit ou écoute). */
const both = (k: TextKey): Bilingual => ({ fr: TEXTS.fr[k], en: TEXTS.en[k] });
/** Texte simple, ou { fr, en } (venu du noyau), dans la langue de l'interface. */
const trx = (x: unknown): string => (x && typeof x === "object" ? ((x as Record<string, unknown>)[lang] ?? (x as Record<string, unknown>).fr ?? Object.values(x).find((v) => typeof v === "string") ?? "") : String(x ?? "")) as string;
/** Nom d'un problème montré dans l'icône (id d'un plugin, ou « dictée », « raccourci »). */
const problemName = (id: string): string => ((TEXTS[lang] ?? TEXTS.fr).problemNames as Record<string, string>)[id.startsWith("raccourci_") ? "raccourci" : id] ?? id;
/** Erreur dont le message existe en fr et en en (`text`). */
const textError = (text: Bilingual): Error & { text: Bilingual } => Object.assign(new Error(text.fr), { text });
const waitText = (missing?: string[]) => `${T("waits")} ${(missing ?? []).join(", ")}`;
function setLang(l: unknown): void {
  if ((l !== "fr" && l !== "en") || l === lang) return;
  lang = l;
  settingsWin?.setTitle(T("settingsTitle"));
  onbWin?.setTitle(T("onboardingTitle"));
  textWin?.setTitle(T("textTitle"));
  textWin?.webContents.send("text:lang", lang);
  // Les autres fenêtres suivent aussi la langue de l'interface, tout de suite.
  if (docsWin && !docsWin.isDestroyed()) docsWin.webContents.send("documents:lang", lang);
  if (dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:lang", lang);
  if (win && !win.isDestroyed() && winReady) win.webContents.send("display", { ...display, lang });
  refreshTray();
}

// ------------------------------------------------------------------ icône : un rond de couleur (PNG fait main)

const dotIcon = (rgb: Rgb) => nativeImage.createFromBuffer(dotPng(rgb));

function refreshTray() {
  // À la fermeture, l'icône et la fenêtre sont détruites avant la fin du noyau : ne plus y toucher.
  if (quitting || !tray || tray.isDestroyed()) return;
  const shown = problems.size ? "error" : (kernel ? (dictating ? "dictating" : state) : "starting");
  tray.setImage(dotIcon(COLORS[shown] ?? COLORS.idle!));
  const lines = [`Floppy : ${problems.size ? T("problem") : (["idle", "listening", "thinking", "speaking", "sleep", "starting", "dictating"].includes(shown) ? T(shown as TextKey) : shown)}`];
  for (const [id, p] of problems) lines.push(`✖ ${problemName(id)} : ${trx(p)}`.slice(0, 120));
  tray.setToolTip(lines.join("\n").slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: lines[0], enabled: false },
    ...[...problems].map(([id, p]) => ({ label: `✖ ${problemName(id)} : ${trx(p)}`.slice(0, 90), enabled: false })),
    { type: "separator" },
    { label: pttOn ? T("pttStop") : T("pttStart"), click: togglePtt },
    { label: T("write"), click: openTextInput },
    { label: dictating ? T("dictateStop") : T("dictateStart"), click: toggleDictate },
    { label: muted ? T("wake") : T("mute"), click: toggleMute },
    { label: win && !win.isDestroyed() && win.isVisible() ? T("hide") : T("show"), click: toggleWindow },
    { label: T("replace"), click: () => { placeHome(); showWin(); } },
    { label: T("settings"), click: openSettings },
    { label: T("firstSetup"), click: openOnboarding },
    { type: "separator" },
    { label: T("restart"), click: () => restartKernel() },
    { label: T("logs"), click: () => shell.openPath(logDir) },
    { label: T("quit"), click: () => app.quit() },
  ]));
}

// ------------------------------------------------------------------ noyau
const RESTART_DELAYS = [2000, 5000, 15000, 60000];
const CRASH_WINDOW = 120000;
const CRASH_MAX = 5;
/** Pannes récentes (la dernière comprise) → attente avant la relance, ou null : trop de pannes, on arrête et on le montre. */
function restartDelay(times: number[], now: number): number | null {
  const recent = times.filter((t) => now - t < CRASH_WINDOW);
  if (recent.length >= CRASH_MAX) return null;
  return RESTART_DELAYS[Math.min(Math.max(recent.length - 1, 0), RESTART_DELAYS.length - 1)]!;
}

function startKernel() {
  kernelWantsPort = false;
  problems.clear();
  // La raison du dernier démarrage raté reste visible jusqu'à un démarrage réussi (kernel.ready).
  if (bootFailure) problems.set("noyau", bootFailure);
  const entry = join(here, "kernel.ts");
  // Nouveau répertoire de travail choisi : le journal suit.
  const dir = homeDir();
  if (dir !== logDir) { kernelLog.end(); logDir = dir; kernelLog = openLog(logDir); }
  kernel = utilityProcess.fork(entry, CONFIG ? [CONFIG] : [], { stdio: "pipe", serviceName: "Floppy - noyau", cwd: ROOT });
  const source = kernel;
  const forward = (d: Buffer) => { process.stdout.write(d); kernelLog.write(d); };
  kernel.stdout?.on("data", forward);
  kernel.stderr?.on("data", forward);
  kernel.on("message", (m: Msg) => {
    if (quitting || kernel !== source) return;
    if (m?.type === "need-body-port") { kernelWantsPort = true; connectBody(); }
    else if (m?.type === "kernel.failed") bootFailure = m.text ?? null;
    else if (m?.type === "restart") restartKernel();
    else if (m?.type === "display") applyDisplay(m.settings);
    else if (m?.type === "settings.open") {
      const source = kernel;
      // Page demandée (« ouvre les réglages d'Orca ») : rubrique + élément, des textes courts seulement.
      const t = m.target;
      const ok = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;
      const target = t && ok(t.section) && ok(t.provider) && ok(t.id) ? { section: t.section, provider: t.provider, id: t.id } : null;
      void showSettingsConfirmed().then(
        () => {
          if (target) settingsWin?.webContents.send("settings:focus", target);
          source?.postMessage({ type: "settings.open.result", reqId: m.reqId, ok: true });
        },
        (error: unknown) => {
          const e = error as { text?: Bilingual; message?: unknown };
          // Texte { fr, en } : le noyau le dit dans la langue de l'assistant.
          const why = e?.text ?? { fr: String(e?.message ?? error), en: String(e?.message ?? error) };
          const text = { fr: `${TEXTS.fr.settingsNotOpened} : ${why.fr}`, en: `${TEXTS.en.settingsNotOpened}: ${why.en}` };
          source?.postMessage({ type: "settings.open.result", reqId: m.reqId, ok: false, text });
        },
      );
    }
    else if (m?.type === "settings") { setLang(m.lang); lastSettings = { list: m.list, sections: m.sections ?? [], plugins: m.plugins, slots: m.slots ?? [], lang }; settingsWin?.webContents.send("settings:update", lastSettings); }
    else if (m?.type === "items") { setLang(m.lang); lastItems = { providers: m.providers, lang }; sendItems(); }
    else if (m?.type === "items.result") {
      // Opération lancée par un clic dans la fenêtre des réglages : on peut ouvrir une page (http(s)) et copier un code.
      if (m.ok && typeof m.copy === "string" && m.copy.length < 200) clipboard.writeText(m.copy);
      if (m.ok && typeof m.open === "string") { try { const u = new URL(m.open); if (u.protocol === "https:" || u.protocol === "http:") void shell.openExternal(u.toString()); } catch { /* adresse invalide */ } }
      // audio : le son d'un essai ou de « Écouter » (adresse data:audio/…), joué par la fenêtre.
      const audio = typeof m.audio === "string" && m.audio.startsWith("data:audio/") ? m.audio : undefined;
      pending.get(m.reqId)?.({ ok: m.ok, text: m.text, id: m.id, children: m.children, ...(audio ? { audio } : {}) });
      pending.delete(m.reqId);
    }
    else if (m?.type === "coder.event") settingsWin?.webContents.send("coder:event", m.event);
    else if (m?.type === "coder.result") { pending.get(m.reqId)?.(m); pending.delete(m.reqId); }
    else if (m?.type === "onboarding.state") {
      lastOnb = m.state;
      if (onbWin && !onbWin.isDestroyed()) onbWin.webContents.send("onboarding:state", m.state);
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("onboarding:state", m.state);
    }
    else if (m?.type === "onboarding.result") { pending.get(m.reqId)?.({ ok: m.ok, value: m.value, text: m.text }); pending.delete(m.reqId); }
    else if (m?.type === "settings.result") { pending.get(m.reqId)?.({ ok: m.ok, text: m.text }); pending.delete(m.reqId); }
    else if (m?.type === "plugin.state") {
      if (m.state === "error" || m.state === "waiting") problems.set(m.id, m.error ?? waitText(m.missing));
      else problems.delete(m.id);
      refreshTray();
    } else if (m?.type === "kernel.ready") {
      bootFailure = null;
      problems.delete("noyau");
      for (const p of m.plugins) if (p.state === "error" || p.state === "waiting") problems.set(p.id, p.error ?? waitText(p.missing));
      refreshTray();
      // Fabricants des puces vues par l'appli : un indice pour la lecture de la machine, si aucune sonde ne répond.
      void app.getGPUInfo("basic").then((info) => {
        const gpus = ((info as { gpuDevice?: { vendorId: number; deviceString?: string }[] } | null)?.gpuDevice ?? []).map((g) => ({ vendorId: g.vendorId, name: g.deviceString ?? "" }));
        source.postMessage({ type: "onboarding.hint", gpus });
      }).catch(() => {}).finally(() => { if (m.firstRun) openOnboarding(); });
    }
  });
  kernel.on("exit", (code: number) => {
    if (kernel !== source) return;
    kernel = null;
    currentPorts = null;
    // Les demandes en cours n'auront jamais de réponse : on les clôt tout de suite (sinon 30-60 s d'attente).
    for (const [id, done] of [...pending]) { pending.delete(id); try { done({ ok: false, text: T("noAnswer"), error: T("noAnswer") }); } catch { /* résolveur déjà parti */ } }
    if (quitting) return;
    if (restarting) { restarting = false; startKernel(); return; }
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW), now];
    const delay = restartDelay(crashes, now);
    if (delay === null) {
      // Le noyau s'arrête sans cesse (souvent : floppy.yml invalide) : on ne relance plus, on montre pourquoi.
      problems.set("noyau", bootFailure ?? { fr: TEXTS.fr.kernelLoop, en: TEXTS.en.kernelLoop });
      kernelLog.write(`\n[app] le noyau s'est arrêté ${crashes.length} fois en 2 min (code ${code}) : relance arrêtée\n`);
      refreshTray();
      return;
    }
    if (bootFailure) problems.set("noyau", bootFailure);
    refreshTray();
    kernelLog.write(`\n[app] le noyau s'est arrêté (code ${code}) : relance dans ${delay / 1000} s\n`);
    setTimeout(() => { if (!kernel && !quitting) startKernel(); }, delay);
  });
  refreshTray();
}

function restartKernel() {
  // Relance à la main : on repart de zéro (pannes oubliées, problème du noyau effacé).
  crashes = [];
  bootFailure = null;
  problems.delete("noyau");
  if (!kernel) return startKernel();
  restarting = true;
  kernel.postMessage({ type: "stop" });
  const k = kernel;
  setTimeout(() => { if (k === kernel) k.kill(); }, 6000);
}

/** Un nouveau MessagePort entre l'avatar et le noyau (au démarrage, et à chaque rechargement de la fenêtre). */
function connectBody() {
  if (!kernel || !kernelWantsPort || !win || !winReady) return;
  if (currentPorts) { try { currentPorts.port1.close(); } catch { /* déjà fermé */ } }
  currentPorts = new MessageChannelMain();
  kernel.postMessage({ type: "body-port" }, [currentPorts.port1]);
  win.webContents.postMessage("body-port", null, [currentPorts.port2]);
}

// ------------------------------------------------------------------ fenêtre de l'avatar
/** Place de départ de l'avatar : en bas à droite de l'écran principal. */
function homePosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - W - 12, y: wa.y + wa.height - H - 8 };
}
function placeHome() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = homePosition();
  win.setBounds({ x, y, width: W, height: H });
}
/** Après un déplacement : l'avatar doit rester dans l'écran le plus proche (sinon il est perdu). */
function keepOnScreen() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
  if (x !== b.x || y !== b.y || b.width !== W || b.height !== H) win.setBounds({ x, y, width: W, height: H });
}

/** Écrans dans l'ordre que l'utilisateur dit : 1 = principal, puis de gauche à droite. */
function displaysInOrder() {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id).sort((a, b) => a.bounds.x - b.bounds.x)];
}
/**
 * Placer l'avatar (outil vocal « placer_avatar »). coin : bas_droite, bas_gauche, haut_droite, haut_gauche, centre.
 * ecran : numéro (1 = principal). cible "fenetre" : dans le coin de la fenêtre active (le terminal, le navigateur…).
 */
function placeAvatar(opts: { coin?: string; ecran?: number; cible?: string } = {}): Bilingual {
  if (!win || win.isDestroyed()) throw textError({ fr: "l'avatar n'a pas de fenêtre", en: "the avatar has no window" });
  let active: Area | null = null;
  if (opts.cible === "fenetre") {
    const r = process.platform === "win32" ? foregroundRect() : null;
    const dip = r && r.width > 0 && r.height > 0 ? screen.screenToDipRect(null, r) : null;
    if (dip) {
      const wa = screen.getDisplayMatching(dip).workArea;
      // La partie visible de la fenêtre (une fenêtre agrandie déborde un peu de l'écran).
      const x = Math.max(dip.x, wa.x), y = Math.max(dip.y, wa.y);
      active = { x, y, width: Math.min(dip.x + dip.width, wa.x + wa.width) - x, height: Math.min(dip.y + dip.height, wa.y + wa.height) - y };
    }
  }
  let spot;
  try { spot = avatarSpot(opts, { screens: displaysInOrder().map((d) => d.workArea), active, W, H }); }
  catch (e) { throw e instanceof Error ? e : textError(e as Bilingual); }
  win.setBounds({ x: spot.x, y: spot.y, width: W, height: H });
  keepOnScreen();
  showWin();
  return spot.text;
}

function createWindow() {
  const home = homePosition();
  win = new BrowserWindow({
    width: W, height: H, x: home.x, y: home.y,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    show: false, backgroundColor: "#00000000",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating");
  win.loadFile(join(here, "renderer", "index.html"));
  win.once("ready-to-show", () => { if (display.avatar_visible) win?.showInactive(); });
  win.setIgnoreMouseEvents(true, { forward: true }); // clics traversants, sauf sur la tête et la bulle (voir "interactive")
  // Vérification : FLOPPY_SNAPSHOT=<fichier.png> capture la fenêtre de l'avatar toutes les 3 s.
  const snapshot = process.env.FLOPPY_SNAPSHOT;
  if (snapshot) setInterval(async () => {
    // À la fermeture, la fenêtre peut déjà être détruite : on ne capture plus rien.
    if (quitting || !win || win.isDestroyed()) return;
    const fs = await import("node:fs");
    const img = await win.webContents.capturePage().catch(() => null);
    if (!img) return;
    fs.writeFileSync(snapshot, img.toPNG());
    // Et la fenêtre des réglages si elle est ouverte : <fichier>-reglages.png
    if (settingsWin && !settingsWin.isDestroyed()) {
      // FLOPPY_SETTINGS_SCROLL=<px> : fait défiler la rubrique avant l'image (vérifier le bas d'une page).
      if (process.env.FLOPPY_SETTINGS_SCROLL) await settingsWin.webContents.executeJavaScript(`for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = ${Number(process.env.FLOPPY_SETTINGS_SCROLL) || 0}`).catch(() => {});
      // FLOPPY_SETTINGS_JS=<code> : action avant l'image (ex. cliquer « Ajouter » pour vérifier un formulaire).
      if (process.env.FLOPPY_SETTINGS_JS) await settingsWin.webContents.executeJavaScript(process.env.FLOPPY_SETTINGS_JS).catch(() => {});
      const s = await settingsWin.webContents.capturePage();
      fs.writeFileSync(snapshot.replace(/\.png$/i, "-reglages.png"), s.toPNG());
    }
    // Et la fenêtre « Bienvenue » : <fichier>-bienvenue.png (FLOPPY_ONBOARDING_JS=<code> : action avant l'image).
    if (onbWin && !onbWin.isDestroyed()) {
      if (process.env.FLOPPY_ONBOARDING_JS) await onbWin.webContents.executeJavaScript(process.env.FLOPPY_ONBOARDING_JS).catch(() => {});
      const o = await onbWin.webContents.capturePage().catch(() => null);
      if (o) fs.writeFileSync(snapshot.replace(/\.png$/i, "-bienvenue.png"), o.toPNG());
    }
  }, 3000);
  // Messages de la page de l'avatar → console et journal (état du micro, erreurs).
  win.webContents.on("console-message", (e) => { const line = `[avatar] ${e.message}\n`; process.stdout.write(line); kernelLog.write(line); });
  win.webContents.on("did-start-loading", () => { winReady = false; });
  win.webContents.on("did-finish-load", () => { winReady = true; connectBody(); win?.webContents.send("display", { ...display, lang }); });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win?.hide(); refreshTray(); } });
  win.on("closed", () => { win = null; winReady = false; clearTimeout(idleTimer); clearTimeout(tempTimer); });
  // Comme les autres fenêtres : jamais de navigation ni de nouvelle fenêtre depuis l'avatar.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Les yeux de l'avatar suivent la souris, même hors de sa fenêtre : position relative à la fenêtre, si elle a bougé.
  let lastCursor = "";
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || !winReady) return;
    const pt = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const key = `${pt.x - b.x},${pt.y - b.y}`;
    if (key === lastCursor) return;
    lastCursor = key;
    win.webContents.send("cursor", { x: pt.x - b.x, y: pt.y - b.y });
  }, 50);
  win.on("closed", () => { clearInterval(cursorTimer); cursorTimer = undefined; });
}

// ------------------------------------------------------------------ affichage : visible, masquage auto, apparition à la demande
function hideWin() { if (!quitting && win && !win.isDestroyed() && win.isVisible()) win.hide(); refreshTray(); }
function showWin() { if (!quitting && win && !win.isDestroyed() && !win.isVisible()) win.showInactive(); refreshTray(); }

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  if (quitting || !win || win.isDestroyed() || !display.masquer_apres || !display.avatar_visible || !win.isVisible()) return;
  idleTimer = setTimeout(() => { if (state === "idle" && !approvalOpen) hideWin(); else armIdleTimer(); }, display.masquer_apres * 60000);
}

/** Toute activité (état actif, carte d'accord, raccourci, clic sur l'icône) : montre la fenêtre si besoin et relance le minuteur. */
function activity() {
  if (quitting || !win || win.isDestroyed()) return;
  clearTimeout(tempTimer);
  if (win && !win.isVisible()) {
    if (!display.avatar_visible) tempShown = true;
    showWin();
  }
  armIdleTimer();
}

/** Retour au calme : une apparition temporaire se referme après la période d'écoute libre. */
function settleIdle() {
  armIdleTimer();
  if (!tempShown) return;
  clearTimeout(tempTimer);
  tempTimer = setTimeout(() => {
    if (state === "idle" && !approvalOpen && !display.avatar_visible) { tempShown = false; hideWin(); }
  }, FREE_LISTEN_MS);
}

let approvalOpen = false;

/**
 * Démarrage avec Windows (clé « Exécuter » de l'utilisateur, par Electron). En dev, l'exécutable est electron.exe :
 * on lui passe le dossier de l'app. Le noyau garde le réglage ; ici on l'applique seulement s'il change.
 */
function applyLoginItem(on: boolean): void {
  const opts = { name: "Floppy", ...(app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }) };
  // `openAtLogin` reste à false avec un nom et des arguments : le vrai état est `executableWillLaunchAtLogin`.
  if (app.getLoginItemSettings(opts).executableWillLaunchAtLogin === on) return;
  app.setLoginItemSettings({ ...opts, openAtLogin: on, enabled: on });
  kernelLog.write(`[app] démarrage avec Windows : ${on ? "activé" : "désactivé"}\n`);
}

function applyDisplay(s: unknown): void {
  if (quitting || !s || typeof s !== "object") return;
  display = { ...display, ...(s as Partial<Display>) };
  if (typeof display.demarrage_windows === "boolean") applyLoginItem(display.demarrage_windows);
  if (display.raccourcis && typeof display.raccourcis === "object") applyShortcuts(display.raccourcis);
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!display.toujours_devant, "floating");
  win.webContents.send("display", { ...display, lang });
  if (display.avatar_visible) { tempShown = false; clearTimeout(tempTimer); showWin(); }
  else if (!tempShown) hideWin();
  armIdleTimer();
}

/** Ctrl+Alt+H / icône : passe par le noyau pour que le réglage `avatar_visible` reste juste (et gardé). */
function toggleWindow() {
  if (quitting || !win || win.isDestroyed()) return;
  const show = !win.isVisible();
  tempShown = false;
  clearTimeout(tempTimer);
  applyDisplay({ avatar_visible: show });
  kernelRequest({ type: "settings.set", key: "avatar_visible", value: show });
}

function kernelRequest(msg: Msg): Promise<any> {
  if (!kernel) return Promise.resolve({ ok: false, text: T("noKernel") });
  const reqId = ++reqSeq;
  return new Promise((res) => {
    const t = setTimeout(() => { pending.delete(reqId); res({ ok: false, text: T("noAnswer") }); }, 60000);
    pending.set(reqId, (r) => { clearTimeout(t); res(r); });
    kernel?.postMessage({ ...msg, reqId });
  });
}

// ------------------------------------------------------------------ fenêtre des réglages
// ------------------------------------------------------------------ fenêtre de résultats (A2UI)
let panelWin: BrowserWindow | null = null;
function openPanel(data: Msg | undefined): void {
  const payload = { title: String(data?.title ?? "").slice(0, 200), a2ui: Array.isArray(data?.a2ui) ? data.a2ui : [], lang };
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send("panel:show", payload);
    bringToFront(panelWin);
    return;
  }
  panelWin = safeWindow({ size: { width: 620, height: 720, minWidth: 380, minHeight: 300 }, title: T("panelTitle"), background: "#0b0f15", preload: "preload-panel.cjs" });
  panelWin.loadFile(join(here, "renderer", "panel.html"));
  panelWin.webContents.once("did-finish-load", () => { panelWin?.webContents.send("panel:show", payload); bringToFront(panelWin); });
  panelWin.on("closed", () => { panelWin = null; });
}

// ------------------------------------------------------------------ fenêtre « Documents » (Markdown)
// Le Markdown est rendu ici (Node), jamais dans la fenêtre : elle ne reçoit que du HTML nettoyé (voir markdown.mjs).
let docsWin: BrowserWindow | null = null;
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/;
/** Liste des documents venue de la page de l'avatar : nettoyée avant d'aller dans la fenêtre. */
const cleanDocList = (l: unknown) => (Array.isArray(l) ? l : []).slice(0, 60)
  .filter((d: Msg) => d && DOC_ID.test(String(d.id)))
  .map((d: Msg) => ({ id: String(d.id), titre: String(d.titre ?? "").slice(0, 200), date: String(d.date ?? ""), tags: Array.isArray(d.tags) ? d.tags.map(String).slice(0, 10) : [] }));
function openDocuments(m: Msg | undefined): void {
  const liste = cleanDocList(m?.liste);
  const payload = { id: String(m?.id ?? ""), titre: String(m?.titre ?? "").slice(0, 200), html: renderMarkdown(m?.markdown), liste, lang };
  if (docsWin && !docsWin.isDestroyed()) {
    docsWin.webContents.send("documents:show", payload);
    bringToFront(docsWin);
    return;
  }
  docsWin = safeWindow({ size: { width: 1020, height: 760, minWidth: 520, minHeight: 320 }, title: T("documentsTitle"), background: "#0b0f15", preload: "preload-documents.cjs" });
  docsWin.loadFile(join(here, "renderer", "documents.html"));
  docsWin.webContents.once("did-finish-load", () => { docsWin?.webContents.send("documents:show", payload); bringToFront(docsWin); });
  docsWin.on("closed", () => { docsWin = null; });
}

function openSettings() {
  if (settingsWin) { bringToFront(settingsWin); return settingsWin; }
  settingsWin = safeWindow({ size: { width: 1180, height: 760, minWidth: 480, minHeight: 420 }, title: T("settingsTitle"), background: "#0d1118", preload: "preload-settings.cjs" });
  // Vérification : FLOPPY_SETTINGS_PAGE=<rubrique> ouvre les réglages sur cette rubrique (avec FLOPPY_SNAPSHOT : image).
  const page = process.env.FLOPPY_SETTINGS_PAGE;
  settingsWin.loadFile(join(here, "renderer", "settings.html"), page ? { hash: page } : undefined);
  settingsWin.once("ready-to-show", () => bringToFront(settingsWin));
  settingsWin.on("closed", () => {
    settingsWin = null;
    for (const id of coderSessions) kernel?.postMessage({ type: "coder.close", sessionId: id });
    coderSessions.clear();
  });
  kernel?.postMessage({ type: "settings.get" });
  kernel?.postMessage({ type: "items.get" });
  return settingsWin;
}

// ------------------------------------------------------------------ fenêtre « Bienvenue » (premier lancement)
function openOnboarding() {
  if (onbWin && !onbWin.isDestroyed()) { bringToFront(onbWin); return onbWin; }
  onbWin = safeWindow({ size: { width: 820, height: 700, minWidth: 420, minHeight: 480 }, title: T("onboardingTitle"), background: "#0b0f15", preload: "preload-onboarding.cjs" });
  onbWin.loadFile(join(here, "renderer", "onboarding.html"));
  onbWin.once("ready-to-show", () => bringToFront(onbWin));
  onbWin.on("closed", () => { onbWin = null; });
  return onbWin;
}

async function showSettingsConfirmed(): Promise<void> {
  const target = openSettings();
  if (target.webContents.isLoadingMainFrame()) await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.webContents.removeListener("did-finish-load", loaded);
      target.webContents.removeListener("did-fail-load", failed);
      target.removeListener("closed", closed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = (_e: unknown, _code: number, description: string, _url: string, mainFrame: boolean) => { if (mainFrame) { cleanup(); reject(new Error(description)); } };
    const closed = () => { cleanup(); reject(textError(both("closedWhileLoading"))); };
    const timer = setTimeout(() => { cleanup(); reject(textError(both("loadTooLong"))); }, 8000);
    target.webContents.once("did-finish-load", loaded);
    target.webContents.on("did-fail-load", failed);
    target.once("closed", closed);
  });
  bringToFront(target);
  if (target.isDestroyed() || !target.isVisible()) throw textError(both("notVisible"));
}

function openTextInput() {
  if (textWin && !textWin.isDestroyed()) { bringToFront(textWin); textWin.webContents.send("text:focus"); return textWin; }
  textWin = safeWindow({ size: { width: 560, height: 340, minWidth: 360, minHeight: 320 }, title: T("textTitle"), preload: "preload-text.cjs" });
  textWin.loadFile(join(here, "renderer", "text.html"));
  textWin.webContents.once("did-finish-load", () => textWin?.webContents.send("text:lang", lang));
  textWin.once("ready-to-show", () => { bringToFront(textWin); textWin?.webContents.send("text:focus"); });
  textWin.on("closed", () => { textWin = null; });
  return textWin;
}
/** N'accepte que la fenêtre de saisie et un avatar connecté ; un échec conserve le brouillon. */
function submitText(e: { sender: unknown }, raw: unknown): boolean {
  if (!textWin || e.sender !== textWin.webContents) return false;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 10000 || !kernel || !currentPorts || !winReady || !win || win.isDestroyed()) return false;
  activity();
  muted = false;
  win.webContents.send("text-request", raw.trim());
  refreshTray();
  return true;
}
function togglePtt() { activity(); pttOn = !pttOn; win?.webContents.send("shortcut", pttOn ? "ptt-on" : "ptt-off"); refreshTray(); }
/** Pilule de dictée : en bas au centre de l'écran où est la souris, sans jamais prendre le focus. */
function showDictationPill() {
  clearTimeout(dictHideTimer);
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = 240, h = 56;
  const bounds = { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + wa.height - h - 16, width: w, height: h };
  if (!dictWin || dictWin.isDestroyed()) {
    dictWin = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
      focusable: false, hasShadow: false, show: false, backgroundColor: "#00000000",
      webPreferences: { preload: join(here, "preload-dictation.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    dictWin.setAlwaysOnTop(true, "screen-saver");
    dictWin.loadFile(join(here, "renderer", "dictation.html"));
    dictWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    dictWin.webContents.on("will-navigate", (e) => e.preventDefault());
    dictWin.webContents.once("did-finish-load", () => dictWin?.webContents.send("dictation:lang", lang));
    dictWin.once("ready-to-show", () => { if (dictating) { dictWin?.showInactive(); dictWin?.webContents.send("dictation:state", "listening"); } });
    dictWin.on("closed", () => { dictWin = null; });
  } else {
    dictWin.setBounds(bounds);
    dictWin.showInactive();
    dictWin.webContents.send("dictation:state", "listening");
  }
}
/** Après l'arrêt : les dernières phrases arrivent encore (environ 1 s), puis la pilule disparaît. */
function finishDictationPill() {
  if (!dictWin || dictWin.isDestroyed()) return;
  dictWin.webContents.send("dictation:state", "finishing");
  clearTimeout(dictHideTimer);
  dictHideTimer = setTimeout(() => { if (!dictating) dictWin?.hide(); }, 1500);
}

function toggleDictate() {
  dictating = !dictating;
  if (dictating) {
    try { typer ??= new Typer((msg) => { kernelLog.write(`[app] ${msg}
`); console.log(`[app] ${msg}`); }); }
    catch (e) { const err = e as { text?: Bilingual; message?: unknown }; dictating = false; problems.set("dictée", err?.text ?? String(err?.message ?? e)); refreshTray(); return; }
    typer.reset();
    showDictationPill();
  } else finishDictationPill();
  win?.webContents.send("shortcut", dictating ? "dictate-on" : "dictate-off");
  refreshTray();
}
function toggleMute() { muted = !muted; win?.webContents.send("shortcut", muted ? "mute-on" : "mute-off"); refreshTray(); }

const SHORTCUT_ACTIONS: Record<string, () => void> = { ecrire: () => openTextInput(), parler: () => togglePtt(), dicter: () => toggleDictate(), dormir: () => toggleMute(), avatar: () => toggleWindow() };
const registered = new Map<string, string>(); // action -> raccourci posé
/** Pose les raccourcis globaux choisis. Un raccourci déjà pris par une autre app (ex. Ctrl+Alt+Espace) est signalé. */
function applyShortcuts(next: unknown): void {
  if (!app.isReady()) return;
  for (const [a, fn] of Object.entries(SHORTCUT_ACTIONS)) {
    const chosen = (next as Record<string, unknown> | null | undefined)?.[a];
    const keys = typeof chosen === "string" ? chosen : SHORTCUT_DEFAULTS[a]!;
    shortcuts[a] = keys;
    if (registered.get(a) === keys) continue;
    const old = registered.get(a);
    if (old) { try { globalShortcut.unregister(old); } catch { /* déjà retiré */ } }
    registered.delete(a);
    problems.delete(`raccourci_${a}`);
    if (!keys) continue;
    let ok = false;
    try { ok = globalShortcut.register(keys, fn); } catch { ok = false; }
    kernelLog.write(`[app] raccourci ${keys} (${a}) : ${ok ? "ok" : "DÉJÀ PRIS par une autre app"}\n`);
    if (ok) registered.set(a, keys);
    else problems.set(`raccourci_${a}`, { fr: `${keysForOS(keys)} ${TEXTS.fr.taken}`, en: `${keysForOS(keys)} ${TEXTS.en.taken}` });
  }
  refreshTray();
}

// ------------------------------------------------------------------ démarrage
app.whenReady().then(() => {
  // Micro : seulement pour nos fenêtres (fichiers locaux) : l'avatar, et les réglages (enregistrer une voix). Rien d'autre.
  const micOk = (wc: WebContents | null | undefined) => !!wc && (wc === win?.webContents || (!!settingsWin && !settingsWin.isDestroyed() && wc === settingsWin.webContents));
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === "media" && micOk(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === "media" && micOk(wc));
  tray = new Tray(dotIcon(COLORS.starting!));
  tray.on("click", toggleWindow);
  createWindow();
  startKernel();
  if (process.env.FLOPPY_SETTINGS_PAGE) setTimeout(openSettings, 3000);
  // Raccourcis globaux. Un raccourci déjà pris par une autre app (ex. Claude desktop prend Ctrl+Alt+Espace) est signalé.
  applyShortcuts(display.raccourcis ?? shortcuts);

  ipcMain.on("state", (_e, s) => {
    state = s;
    if (s !== "listening") pttOn = pttOn && s === "listening";
    if (s === "listening" || s === "thinking" || s === "speaking") activity(); else if (s === "idle") settleIdle();
    refreshTray();
  });
  ipcMain.on("activity", (_e, kind) => { approvalOpen = kind === "approval"; activity(); });
  ipcMain.on("approval-closed", () => { approvalOpen = false; settleIdle(); });
  ipcMain.handle("text:submit", (e, text) => submitText(e, text));
  ipcMain.on("text:close", (e) => { if (textWin && e.sender === textWin.webContents) textWin.close(); });
  ipcMain.on("open-settings", () => openSettings());
  // Réponse : { ok, text: { fr, en } } ; la page de l'avatar choisit la langue de l'assistant (c'est Floppy qui le dit).
  ipcMain.handle("avatar:place", (e, a) => {
    if (!win || e.sender !== win.webContents) throw new Error("refusé");
    try {
      return { ok: true, text: placeAvatar({ coin: String(a?.coin ?? "bas_droite"), ecran: a?.ecran === undefined ? undefined : Number(a.ecran), cible: a?.cible === "fenetre" ? "fenetre" : "ecran" }) };
    } catch (error) {
      const err = error as { text?: Bilingual; message?: unknown };
      return { ok: false, text: err?.text ?? String(err?.message ?? error) };
    }
  });
  // Dictée : le noyau envoie les mots confirmés ; seule la page de l'avatar peut les faire taper.
  ipcMain.on("dictation", (e, d) => {
    if (!win || e.sender !== win.webContents || !typer) return;
    const del = Math.max(0, Math.min(500, Number(d?.del) || 0));
    const ins = String(d?.ins ?? "").slice(0, 5000);
    if (del || ins) {
      void typer.edit(del, ins);
      if (dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:typed");
      // Une phrase finale arrive après l'arrêt : la pilule reste un peu, le temps de la voir tapée.
      if (!dictating) finishDictationPill();
    }
  });
  ipcMain.on("dictation:level", (e, v) => {
    if (win && e.sender === win.webContents && dictWin && !dictWin.isDestroyed()) dictWin.webContents.send("dictation:level", Number(v) || 0);
  });
  ipcMain.on("dictation:stop", (e) => { if (dictWin && e.sender === dictWin.webContents && dictating) toggleDictate(); });
  // Fenêtre de résultats : seulement à la demande de la page de l'avatar ; actions seulement depuis la fenêtre.
  ipcMain.on("panel:open", (e, data) => { if (win && e.sender === win.webContents) openPanel(data); });
  ipcMain.on("panel:action", async (e, name, context) => {
    if (!panelWin || e.sender !== panelWin.webContents) return;
    if (name === "ouvrir_url") {
      try {
        const u = new URL(String(context?.url ?? ""));
        if (u.protocol === "https:" || u.protocol === "http:") await shell.openExternal(u.toString());
      } catch { /* adresse invalide : rien */ }
    }
  });
  // Fenêtre « Documents » : ouverte seulement à la demande de la page de l'avatar ; le reste seulement depuis la fenêtre.
  ipcMain.on("documents:open", (e, data) => { if (win && e.sender === win.webContents) openDocuments(data); });
  ipcMain.on("documents:select", (_e, id) => {
    if (!docsWin || _e.sender !== docsWin.webContents) return;
    if (DOC_ID.test(String(id))) win?.webContents.send("document-open", String(id)); // la page de l'avatar le transmet au noyau
  });
  // Supprimer un document : demandé par la fenêtre Documents (2 clics), transmis au noyau par la page de l'avatar.
  ipcMain.on("documents:delete", (e, d) => {
    if (!docsWin || e.sender !== docsWin.webContents) return;
    const id = String(d?.id ?? "");
    const current = String(d?.current ?? "");
    if (!DOC_ID.test(id)) return;
    win?.webContents.send("document-delete", { id, current: DOC_ID.test(current) ? current : "" });
  });
  // Nouvelle liste (après une suppression) : de la page de l'avatar vers la fenêtre Documents, si elle est ouverte.
  ipcMain.on("documents:list", (e, liste) => {
    if (!win || e.sender !== win.webContents) return;
    if (docsWin && !docsWin.isDestroyed()) docsWin.webContents.send("documents:list", cleanDocList(liste));
  });
  ipcMain.on("documents:link", async (e, url) => {
    if (!docsWin || e.sender !== docsWin.webContents) return;
    try {
      const u = new URL(String(url));
      if (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:") await shell.openExternal(u.toString());
    } catch { /* adresse invalide : rien */ }
  });
  // Fenêtre des réglages : seulement depuis sa propre page.
  const fromSettings = (e: { sender: unknown }) => settingsWin && e.sender === settingsWin.webContents;
  // Fenêtre « Bienvenue » : seulement depuis sa propre page.
  const fromOnb = (e: { sender: unknown }) => onbWin && !onbWin.isDestroyed() && e.sender === onbWin.webContents;
  ipcMain.handle("onboarding:get", (e, o) => fromOnb(e) ? kernelRequest({
    type: "onboarding.get", fresh: o?.fresh === true,
    ...(typeof o?.manualBytes === "number" && o.manualBytes >= 0 && o.manualBytes < 2 ** 50 ? { manualBytes: o.manualBytes } : {}),
  }) : null);
  ipcMain.handle("onboarding:apply", (e, level, brain) => fromOnb(e) ? kernelRequest({ type: "onboarding.apply", level: String(level).slice(0, 40), ...(brain ? { brain: String(brain).slice(0, 200) } : {}) }) : null);
  ipcMain.handle("onboarding:skip", (e) => fromOnb(e) ? kernelRequest({ type: "onboarding.skip" }) : null);
  // Répertoire de travail choisi dans « Bienvenue » : le noyau le note puis repart dans ce dossier (réglage dossier_floppy).
  ipcMain.handle("onboarding:home", async (e) => {
    if (!fromOnb(e) || !onbWin) return null;
    const r = await dialog.showOpenDialog(onbWin, { title: T("pickTitle"), properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return kernelRequest({ type: "settings.set", key: "dossier_floppy", value: r.filePaths[0] });
  });
  ipcMain.on("onboarding:close", (e) => { if (fromOnb(e)) onbWin?.close(); });
  ipcMain.on("onboarding:settings", (e) => { if (fromOnb(e)) openSettings(); });
  ipcMain.handle("onboarding:state", (e) => (fromSettings(e) ? lastOnb : null));
  ipcMain.on("open-onboarding", (e) => { if (settingsWin && e.sender === settingsWin.webContents) openOnboarding(); });
  ipcMain.handle("settings:get", (e) => {
    if (!fromSettings(e)) return null;
    kernel?.postMessage({ type: "settings.get" });
    return lastSettings ?? { list: [], sections: [], plugins: [], slots: [], lang };
  });
  // Éléments (catalogue) : liste, opérations (ajouter, modifier, activer…), choix d'un fichier ou d'un dossier.
  ipcMain.handle("items:get", (e) => {
    if (!fromSettings(e)) return null;
    kernel?.postMessage({ type: "items.get" });
    return lastItems ? itemsPayload() : { providers: [], lang };
  });
  ipcMain.handle("items:op", (e, op) => {
    if (!fromSettings(e)) return null;
    if (!op || typeof op !== "object" || typeof op.op !== "string" || typeof op.provider !== "string") return { ok: false, text: T("invalid") };
    return kernelRequest({ type: "items.op", op });
  });
  ipcMain.handle("items:pick", async (e, opts) => {
    if (!fromSettings(e) || !settingsWin) return null;
    const o: Msg = opts && typeof opts === "object" ? opts : {};
    const filters = Array.isArray(o.filters)
      ? o.filters.slice(0, 10).map((f) => ({ name: String(f?.name ?? ""), extensions: Array.isArray(f?.extensions) ? f.extensions.slice(0, 20).map((x: unknown) => String(x).replace(/^\./, "")) : [] }))
      : [];
    const r = await dialog.showOpenDialog(settingsWin, {
      title: T("pickTitle"), properties: [o.directory ? "openDirectory" : "openFile"], ...(filters.length && !o.directory ? { filters } : {}),
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle("settings:set", (e, key, value) => fromSettings(e) ? kernelRequest({ type: "settings.set", key: String(key), value }) : null);
  ipcMain.handle("settings:undo", (e) => fromSettings(e) ? kernelRequest({ type: "settings.undo" }) : null);
  // Assistant IA : relais fenêtre des réglages ↔ service « coder » du noyau.
  const coderCall = (msg: Msg): Promise<any> => {
    if (!kernel) return Promise.resolve({ ok: false, error: T("noKernel") });
    const reqId = ++reqSeq;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(reqId); res({ ok: false, error: T("noAnswer") }); }, 30000);
      pending.set(reqId, (r) => { clearTimeout(t); res(r); });
      kernel?.postMessage({ ...msg, reqId });
    });
  };
  ipcMain.handle("coder:agents", async (e) => {
    if (!fromSettings(e)) return null;
    const r = await coderCall({ type: "coder.agents" });
    return r.ok ? r.value : null;
  });
  ipcMain.handle("coder:start", async (e, agent, mode) => {
    if (!fromSettings(e)) return null;
    const r = await coderCall({ type: "coder.start", agent: String(agent), mode: String(mode) });
    if (r.ok && r.value) coderSessions.add(r.value);
    return { ok: !!r.ok, sessionId: r.value, error: r.error };
  });
  ipcMain.on("coder:send", (e, id, text) => { if (fromSettings(e)) kernel?.postMessage({ type: "coder.send", sessionId: String(id), text: String(text) }); });
  ipcMain.on("coder:cancel", (e, id) => { if (fromSettings(e)) kernel?.postMessage({ type: "coder.cancel", sessionId: String(id) }); });
  ipcMain.on("coder:permission", (e, id, permissionId, allow) => {
    if (fromSettings(e)) kernel?.postMessage({ type: "coder.permission", sessionId: String(id), permissionId: String(permissionId), allow: allow === true });
  });
  ipcMain.on("coder:close", (e, id) => {
    if (!fromSettings(e)) return;
    coderSessions.delete(String(id));
    kernel?.postMessage({ type: "coder.close", sessionId: String(id) });
  });
  ipcMain.on("interactive", (_e, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  // Déplacer l'avatar à la main (la tête n'est plus une zone « drag » : un clic sans bouger la chatouille).
  ipcMain.on("drag", (e, phase) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return;
    const pt = screen.getCursorScreenPoint();
    if (phase === "start") { const [wx, wy] = win.getPosition() as [number, number]; drag = { cx: pt.x, cy: pt.y, wx, wy }; }
    else if (phase === "move" && drag) win.setPosition(Math.round(drag.wx + pt.x - drag.cx), Math.round(drag.wy + pt.y - drag.cy));
    else if (phase === "end") { drag = null; keepOnScreen(); }
  });
});

app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  clearTimeout(idleTimer); clearTimeout(tempTimer);
  globalShortcut.unregisterAll();
  const source = kernel;
  if (!source) return;
  e.preventDefault();
  let finished = false;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timeout); app.quit(); };
  const timeout = setTimeout(() => { source.kill(); finish(); }, 5000);
  source.once("exit", finish);
  try { source.postMessage({ type: "stop" }); } catch { finish(); }
});
app.on("window-all-closed", () => { /* l'app reste dans la barre des tâches */ });
// Une fenêtre dont le rendu plante (avatar, réglages…) est rechargée ; au-delà de 3 pannes en 5 minutes, on la laisse.
let rendererCrashes: number[] = [];
app.on("render-process-gone", (_e, contents, details) => {
  if (quitting || details?.reason === "clean-exit") return;
  const now = Date.now();
  rendererCrashes = [...rendererCrashes.filter((t) => now - t < 300000), now];
  kernelLog.write(`\n[app] une fenêtre s'est arrêtée (${details?.reason}, code ${details?.exitCode})${rendererCrashes.length > 3 ? " : trop de pannes, pas de rechargement" : " : rechargement"}\n`);
  if (rendererCrashes.length > 3) return;
  setTimeout(() => { if (!contents.isDestroyed()) contents.reload(); }, 1000);
});
