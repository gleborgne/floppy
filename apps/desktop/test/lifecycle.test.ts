import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import * as texts from '../src/main-texts.ts';
import * as trayIcon from '../src/tray-icon.ts';
import * as placement from '../src/placement.ts';
import * as chatLog from '../src/chat-log.ts';
import * as markdown from '../src/markdown.ts';
import * as ui from '../src/ui.ts';
import { createDesktopContributions } from '../src/desktop-contributions.ts';

// Le vrai processus principal, dans un bac sans Electron ni processus/fichiers réels.
function desktop(argv: string[] = []) {
  const events = new EventEmitter();
  // Un nouveau processus du noyau à chaque lancement (comme utilityProcess.fork) ; `child` est le dernier.
  const forked: (EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> })[] = [];
  const fork = () => { const c = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); forked.push(c); return c; };
  const app = { quit:vi.fn(), requestSingleInstanceLock:()=>true, commandLine:{appendSwitch(){}}, whenReady:()=>new Promise(()=>{}), on:events.on.bind(events), getAppPath:()=>'.', getLoginItemSettings:()=>({executableWillLaunchAtLogin:false}), setLoginItemSettings(){} };
  // Les modules du processus principal, sans leurs types (comme Node les lit au lancement), puis sans leurs imports ni
  // leurs `export` : le contexte fournit Electron et les modules qui ne bougent pas, et les vrais fichiers sont mis bout à bout
  // (main.ts en dernier, il les relie). Un nouveau module importé par main.ts s'ajoute à cette liste.
  const modules = ['app-texts', 'tray', 'kernel-process', 'kernel-messages', 'avatar', 'app-windows', 'chat-window', 'voice-controls', 'dictation', 'ipc', 'main'];
  const source = modules.map((name) => stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url),'utf8'))
    .replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')).join(String.fromCharCode(10))
    .replaceAll('import.meta.url', JSON.stringify(new URL('../src/main.ts',import.meta.url).href));
  // La fenêtre « Conversation » : un faux qui garde sa place (setBounds / getBounds), sa visibilité et ce qu'on lui envoie.
  let chatBounds = { x: 0, y: 0, width: 0, height: 0 };
  const chatWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }), loadFile: vi.fn(), setTitle: vi.fn(), showInactive: vi.fn(), moveTop: vi.fn(), setAlwaysOnTop: vi.fn(), close: vi.fn(),
    setBounds: vi.fn((b: typeof chatBounds) => { chatBounds = { ...b }; }), getBounds: () => ({ ...chatBounds }),
    state: { visible: true, minimized: false, focused: false }, isVisible() { return this.state.visible; }, isMinimized() { return this.state.minimized; }, isFocused() { return this.state.focused; }, isDestroyed: () => false,
  });
  const avatarBounds = { x: 1588, y: 472, width: 320, height: 560 };
  // La fenêtre de l'avatar (BrowserWindow d'Electron) : un faux qui garde ce que le vrai code lui demande.
  const avatarWindow = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn() }),
    loadFile: vi.fn(), setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents: vi.fn(), setBounds: vi.fn(), showInactive: vi.fn(), hide: vi.fn(),
    getBounds: () => ({ ...avatarBounds }), isDestroyed: () => false, isVisible: () => true,
  });
  class BrowserWindow { constructor() { return avatarWindow as unknown as BrowserWindow; } }
  class MessageChannelMain { port1 = { close() {} }; port2 = {}; }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const screen = { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) };
  const shell = { openExternal: vi.fn(async () => {}) };
  Object.assign(app, { isReady: () => true });
  const shortcut = { unregisterAll() {}, register: vi.fn(() => true), unregister: vi.fn() };
  const context: Record<string, any> = { app, globalShortcut:{unregisterAll(){}}, fileURLToPath, delimiter, dirname,join,resolve, process:{env:{},argv,chdir(){},stdout:{write(){}},execPath:'electron'},mkdirSync(){},existsSync:()=>false,renameSync(){},statSync(){throw new Error('absent');},createWriteStream:()=>({write(){},on(){},end(){}}),readFileSync(){throw new Error('absent');},setTimeout:vi.fn(()=>1),clearTimeout:vi.fn(),setInterval:vi.fn(()=>1),clearInterval:vi.fn(), utilityProcess:{fork}, console, BrowserWindow, MessageChannelMain, screen,
    // Modules du processus principal (les imports sont retirés du source) : les vrais, sauf les fenêtres (Electron).
    ...texts, ...trayIcon, ...placement, ...chatLog, ...markdown, ...ui, createDesktopContributions, structuredClone, URL, shell, safeWindow:vi.fn(() => chatWindow), bringToFront: vi.fn() };
  const popup = vi.fn();
  const menu = { buildFromTemplate: vi.fn(() => ({ popup })) };
  context.Menu = menu;
  context.globalShortcut = shortcut;
  runInNewContext(source+';globalThis.api={contributions,openAvatarMenu:()=>avatar.openAvatarMenu(),applyDisplay:(s)=>avatar.applyDisplay(s),startKernel:()=>kernelProcess.start(),restartDelay,setLang:(l)=>windows.setLang(l),chat,applyShortcuts:(s)=>voice.applyShortcuts(s),cleanDocList,problems:()=>tray.problems,createWindow:()=>avatar.createWindow(),pending:()=>kernelProcess.pending};',context);
  return { api:context.api,menu,popup,events,get child(){ return forked.at(-1)!; },forked,app,chatWindow,avatarWindow,avatarBounds,shell,workArea,shortcut,windows:context.safeWindow,front:context.bringToFront,env:context.process.env as Record<string,string>,timers:context.setTimeout as ReturnType<typeof vi.fn> };
}

it("garde une seule entrée Réglages au boot, sans corps et après panne", () => {
  const d = desktop();
  const settings = () => d.api.contributions.menu('tray').filter((e: { label: string }) => e.label === 'Réglages');
  expect(settings()).toHaveLength(1);
  settings()[0].click(); expect(d.windows).toHaveBeenCalledOnce();
  d.api.startKernel(); expect(settings()).toHaveLength(1);
  const identity = { owner: 'bodyel', id: 'settings', token: 'one' };
  d.child.emit('message', { type: 'desktop.register', ...identity, contribution: { ...identity, title: { fr: 'Réglages', en: 'Settings' }, menus: ['avatar'], order: 10, actions: ['open'] } });
  expect(settings()).toHaveLength(1); expect(d.api.contributions.menu('avatar')).toHaveLength(2);   // « Ouvrir la conversation » (locale) et celle du plugin
  d.child.emit('message', { type: 'plugin.state', id: 'bodyel', state: 'error' });
  expect(settings()).toHaveLength(1); expect(d.api.contributions.menu('avatar')).toHaveLength(1);
  d.child.emit('exit', 1); expect(settings()).toHaveLength(1);
});

it("le menu de l'avatar propose d'ouvrir la conversation, puis les contributions actives", () => {
  const d = desktop(); d.api.createWindow();
  const labels = () => d.api.contributions.menu('avatar').map((e: { label: string }) => e.label);
  expect(labels()).toEqual(['Ouvrir la conversation']);
  d.api.openAvatarMenu(); expect(d.popup).toHaveBeenCalledWith({ window: d.avatarWindow });
  const identity = { owner: 'demo', id: 'view', token: 'one' };
  d.api.contributions.message({ type: 'desktop.register', ...identity, contribution: { ...identity, title: { fr: 'Autre', en: 'Other' }, menus: ['avatar'], actions: ['open'] } });
  expect(labels()).toEqual(['Autre', 'Ouvrir la conversation']);
  d.api.contributions.clear(); expect(labels()).toEqual(['Ouvrir la conversation']);   // l'entrée locale ne dépend pas du noyau
  d.api.setLang('en'); expect(labels()).toEqual(['Open the conversation']);
  d.api.contributions.menu('avatar')[0].click();
  expect(d.windows).toHaveBeenCalledOnce();
  d.chatWindow.emit('ready-to-show');
  expect(d.front).toHaveBeenCalledWith(d.chatWindow);
});

it("les contributions disparaissent quand le noyau s'arrête", () => {
  const d = desktop(); d.api.startKernel();
  d.child.emit('message', { type: 'desktop.register', owner: 'demo', id: 'action', token: 'one', contribution: { owner: 'demo', id: 'action', token: 'one', title: { fr: 'Action', en: 'Action' }, menus: ['avatar'], actions: ['open'] } });
  expect(d.api.contributions.menu('avatar')).toHaveLength(2);
  d.child.emit('exit', 0);
  expect(d.api.contributions.menu('avatar')).toHaveLength(1);
});

it("le raccourci global ouvre la saisie, se remplace et se désactive", () => {
  const d = desktop();
  d.api.applyShortcuts({});
  const write = d.shortcut.register.mock.calls.find(c => c[0] === 'Ctrl+Alt+T')!;
  expect(write).toBeDefined();
  write[1]();
  expect(d.windows).toHaveBeenCalledOnce();
  d.api.applyShortcuts({write: 'Ctrl+Shift+T'});
  expect(d.shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+T');
  expect(d.shortcut.register).toHaveBeenCalledWith('Ctrl+Shift+T', expect.any(Function));
  d.api.applyShortcuts({write: ''});
  expect(d.shortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+T');
});

/** L'avatar chargé et le port du corps connecté (le vrai chemin : la page est chargée, puis le noyau demande son port). */
function connectAvatar(d: ReturnType<typeof desktop>) {
  d.api.startKernel(); d.api.createWindow();
  d.avatarWindow.webContents.emit('did-finish-load');
  d.child.emit('message', { type: 'need-body-port' });
  d.avatarWindow.webContents.send.mockClear();
  return { sender: d.avatarWindow.webContents };
}

it("la conversation s'ouvre devant avec le focus sur la saisie, près de l'avatar, et réutilise sa fenêtre", () => {
  const d = desktop(); d.api.createWindow();
  d.api.chat.open();
  expect(d.windows).toHaveBeenCalledOnce();
  expect(d.windows.mock.calls[0]![0]).toMatchObject({ preload: 'preload-chat.cjs', title: 'Floppy — Conversation', frameless: true });
  // Avatar en bas à droite : la conversation est juste au-dessus de sa tête, bords droits alignés.
  expect(d.chatWindow.setBounds).toHaveBeenLastCalledWith({ x: 1488, y: 274, width: 420, height: 520 });
  expect(d.front).not.toHaveBeenCalled();                       // rien n'est montré avant que la page soit prête
  d.chatWindow.webContents.emit('did-finish-load');
  expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:init', { lang: 'fr', entries: [], state: '' });
  d.chatWindow.emit('ready-to-show');
  expect(d.front).toHaveBeenCalledWith(d.chatWindow);
  expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:focus');
  d.api.chat.open();
  expect(d.windows).toHaveBeenCalledOnce();
  expect(d.front).toHaveBeenCalledTimes(2);
  expect(d.chatWindow.showInactive).not.toHaveBeenCalled();
});

it("le raccourci global et le titre : la langue de l'interface suit en direct", () => {
  const d = desktop(); d.api.createWindow();
  d.api.chat.open();
  d.chatWindow.setTitle.mockClear();
  d.api.setLang('en');
  expect(d.chatWindow.setTitle).toHaveBeenCalledWith('Floppy — Conversation');
  expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:lang', 'en');
});

it("le journal vit dans l'app depuis le début : la fenêtre le reçoit en entier au chargement puis par changements ; fermée, il reste", () => {
  const d = desktop(); d.api.createWindow();
  const a = { sender: d.avatarWindow.webContents };
  expect(d.api.chat.relay(a, { type: 'transcript', text: 'Bonjour', final: true })).toBe(true);
  expect(d.api.chat.relay(a, { type: 'reply.delta', text: 'Salut' })).toBe(true);
  expect(d.api.chat.relay(a, { type: 'state', state: 'idle' })).toBe(false);                 // pas pour la conversation
  expect(d.api.chat.relay(a, { type: 'transcript', text: 'x', final: false })).toBe(false);
  expect(d.windows).not.toHaveBeenCalled();                                                  // rien ne s'ouvre pour si peu
  d.api.chat.open();
  const send = d.chatWindow.webContents.send;
  d.chatWindow.webContents.emit('did-finish-load');
  expect(send.mock.calls.find((c) => c[0] === 'chat:init')![1].entries).toMatchObject([{ kind: 'you', text: 'Bonjour' }, { kind: 'reply', text: 'Salut', done: false }]);
  send.mockClear();
  d.api.chat.relay(a, { type: 'reply.done', text: 'Salut **toi**' });
  expect(send).toHaveBeenCalledWith('chat:change', { changed: [expect.objectContaining({ kind: 'reply', done: true, html: expect.stringContaining('<strong>toi</strong>') })], removed: [] });
  d.chatWindow.emit('closed');
  d.api.chat.open();
  send.mockClear();
  d.chatWindow.webContents.emit('did-finish-load');
  expect(send.mock.calls.find((c) => c[0] === 'chat:init')![1].entries).toHaveLength(2);
});

it("l'envoi n'arrive qu'à l'avatar connecté, depuis la fenêtre seulement, avec les mêmes vérifications qu'avant", () => {
  const d = desktop();
  d.api.chat.open();
  const e = { sender: d.chatWindow.webContents };
  expect(d.api.chat.submit(e, 'Bonjour')).toBe(false);          // ni noyau ni avatar : le brouillon reste dans la fenêtre
  const a = connectAvatar(d);
  const send = d.avatarWindow.webContents.send;
  expect(d.api.chat.submit({ sender: {} }, 'Bonjour')).toBe(false);
  expect(d.api.chat.submit(a, 'Bonjour')).toBe(false);          // l'avatar n'est pas la fenêtre
  for (const invalid of ['', '  ', null, 'a'.repeat(10001)]) expect(d.api.chat.submit(e, invalid)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(d.api.chat.submit(e, '  Bonjour  ')).toBe(true);
  expect(send).toHaveBeenCalledWith('text-request', 'Bonjour');
  d.chatWindow.emit('closed');
  expect(d.api.chat.submit(e, 'Bonjour')).toBe(false);
});

it("chaque canal de la conversation vérifie son expéditeur : l'avatar relaie et ouvre, la fenêtre répond, accorde, choisit, ferme", () => {
  const d = desktop();
  const a = connectAvatar(d);
  const nobody = { sender: {} };
  d.api.chat.open();
  const c = { sender: d.chatWindow.webContents };
  // Relais et ouverture : l'avatar seulement.
  const notify = { type: 'notify', text: 'x' };
  expect(d.api.chat.relay(nobody, notify)).toBe(false);
  expect(d.api.chat.relay(c, notify)).toBe(false);
  expect(d.api.chat.openFromAvatar(nobody)).toBe(false);
  expect(d.api.chat.openFromAvatar(c)).toBe(false);
  expect(d.api.chat.openFromAvatar(a)).toBe(true);
  // Accord et choix : la fenêtre seulement, pour une demande en attente et une option qui existe.
  d.api.chat.relay(a, { type: 'approval.request', id: 'a1', summary: 'Envoyer ?', ttl_s: 30 });
  d.api.chat.relay(a, { type: 'choice.request', id: 'c1', title: 'Quel ?', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], ttl_s: 30 });
  const send = d.avatarWindow.webContents.send;
  send.mockClear();
  for (const who of [nobody, a]) {
    expect(d.api.chat.answerApproval(who, 'a1', true)).toBe(false);
    expect(d.api.chat.answerChoice(who, 'c1', 'x')).toBe(false);
  }
  expect(d.api.chat.answerApproval(c, 'inconnu', true)).toBe(false);
  expect(d.api.chat.answerApproval(c, 7, true)).toBe(false);
  expect(d.api.chat.answerChoice(c, 'c1', 'z')).toBe(false);
  expect(d.api.chat.answerChoice(c, 'inconnu', 'x')).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(d.api.chat.answerApproval(c, 'a1', true)).toBe(true);
  expect(send).toHaveBeenLastCalledWith('chat-approval', { id: 'a1', ok: true });
  expect(d.api.chat.answerChoice(c, 'c1', 'y')).toBe(true);
  expect(send).toHaveBeenLastCalledWith('chat-choice', { id: 'c1', option: 'y' });
  // Fermées par le noyau : plus de réponse possible.
  d.api.chat.relay(a, { type: 'approval.closed', id: 'a1', ok: true });
  d.api.chat.relay(a, { type: 'choice.closed', id: 'c1', picked: 'y' });
  send.mockClear();
  expect(d.api.chat.answerApproval(c, 'a1', true)).toBe(false);
  expect(d.api.chat.answerChoice(c, 'c1', 'y')).toBe(false);
  expect(send).not.toHaveBeenCalled();
  // Liens : la fenêtre seulement, http, https et mailto seulement.
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'pas une adresse', 42]) expect(d.api.chat.link(c, url)).toBe(false);
  expect(d.api.chat.link(nobody, 'https://example.com')).toBe(false);
  expect(d.api.chat.link(a, 'https://example.com')).toBe(false);
  expect(d.shell.openExternal).not.toHaveBeenCalled();
  expect(d.api.chat.link(c, 'https://example.com/x')).toBe(true);
  expect(d.api.chat.link(c, 'mailto:a@example.com')).toBe(true);
  expect(d.shell.openExternal.mock.calls.map((x: unknown[]) => x[0])).toEqual(['https://example.com/x', 'mailto:a@example.com']);
  // Fermer : la fenêtre seulement.
  expect(d.api.chat.close(nobody)).toBe(false);
  expect(d.api.chat.close(a)).toBe(false);
  expect(d.chatWindow.close).not.toHaveBeenCalled();
  expect(d.api.chat.close(c)).toBe(true);
  expect(d.chatWindow.close).toHaveBeenCalledOnce();
});

it("ipc.ts : chaque canal de la conversation passe l'expéditeur au module qui le vérifie", () => {
  const src = readFileSync(new URL('../src/ipc.ts', import.meta.url), 'utf8');
  for (const channel of ['chat:event', 'chat:open', 'chat:submit', 'chat:approval', 'chat:choice', 'chat:stop-listening', 'chat:link', 'chat:close'])
    expect(src, channel).toMatch(new RegExp(`ipcMain\\.(on|handle)\\("${channel}", \\(e\\b[^)]*\\) => (\\{ )?deps\\.chat\\(\\)\\.\\w+\\(e\\b`));
});

describe("ouverture par Floppy : visible, sans prendre le focus", () => {
  const open = (relay: object) => {
    const d = desktop();
    const a = connectAvatar(d);
    d.api.chat.relay(a, relay);
    return d;
  };
  it("une liste à choisir ouvre la conversation, derrière rien, sans focus", () => {
    const d = open({ type: 'choice.request', id: 'c1', title: 'Quel ?', options: [{ id: 'x', label: 'X' }], ttl_s: 30 });
    expect(d.windows).toHaveBeenCalledOnce();
    d.chatWindow.webContents.emit('did-finish-load');
    d.chatWindow.emit('ready-to-show');
    expect(d.chatWindow.showInactive).toHaveBeenCalledOnce();
    expect(d.chatWindow.moveTop).toHaveBeenCalledOnce();
    expect(d.front).not.toHaveBeenCalled();
    expect(d.chatWindow.webContents.send).not.toHaveBeenCalledWith('chat:focus');
    expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:init', expect.objectContaining({ entries: [expect.objectContaining({ kind: 'choice' })] }));
  });
  it("une réponse de plus de 600 caractères ou de 12 lignes ouvre la conversation ; une courte, non", () => {
    expect(open({ type: 'reply.done', text: 'Courte.' }).windows).not.toHaveBeenCalled();
    expect(open({ type: 'reply.done', text: 'a'.repeat(600) }).windows).not.toHaveBeenCalled();
    expect(open({ type: 'reply.done', text: Array(12).fill('ligne').join('\n') }).windows).not.toHaveBeenCalled();
    expect(open({ type: 'reply.done', text: 'a'.repeat(601) }).windows).toHaveBeenCalledOnce();
    const d = open({ type: 'reply.done', text: Array(13).fill('ligne').join('\n') });
    expect(d.windows).toHaveBeenCalledOnce();
    d.chatWindow.emit('ready-to-show');
    expect(d.chatWindow.showInactive).toHaveBeenCalledOnce();
    expect(d.front).not.toHaveBeenCalled();
  });
  it("déjà ouverte, elle remonte sans focus ; réduite, elle reste réduite", () => {
    const d = desktop();
    const a = connectAvatar(d);
    d.api.chat.open(); d.chatWindow.emit('ready-to-show');
    d.chatWindow.showInactive.mockClear(); d.chatWindow.moveTop.mockClear(); d.front.mockClear();
    d.api.chat.relay(a, { type: 'choice.request', id: 'c1', title: '?', options: [{ id: 'x', label: 'X' }], ttl_s: 30 });
    expect(d.windows).toHaveBeenCalledOnce();
    expect(d.chatWindow.moveTop).toHaveBeenCalledOnce();
    expect(d.front).not.toHaveBeenCalled();
    d.chatWindow.state.minimized = true;
    d.chatWindow.showInactive.mockClear(); d.chatWindow.moveTop.mockClear();
    d.api.chat.relay(a, { type: 'choice.request', id: 'c2', title: '?', options: [{ id: 'x', label: 'X' }], ttl_s: 30 });
    expect(d.chatWindow.showInactive).not.toHaveBeenCalled();
    expect(d.chatWindow.moveTop).not.toHaveBeenCalled();
  });
  it("ouverte mais cachée derrière une autre fenêtre : une nouvelle entrée la fait repasser devant, sans focus", () => {
    const d = desktop();
    const a = connectAvatar(d);
    d.api.chat.open(); d.chatWindow.emit('ready-to-show');
    d.chatWindow.moveTop.mockClear(); d.front.mockClear(); d.timers.mockClear();
    d.api.chat.relay(a, { type: 'transcript', text: 'Quelle heure ?', final: true });
    expect(d.chatWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'screen-saver');
    expect(d.chatWindow.moveTop).toHaveBeenCalledOnce();
    expect(d.front).not.toHaveBeenCalled();
    // Un instant plus tard, elle redevient une fenêtre ordinaire.
    (d.timers.mock.calls.at(-1)![0] as () => void)();
    expect(d.chatWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    // La suite d'une réponse déjà commencée ne la fait pas remonter à chaque morceau.
    d.api.chat.relay(a, { type: 'reply.delta', text: 'Il est ' });
    expect(d.chatWindow.moveTop).toHaveBeenCalledTimes(2);
    d.api.chat.relay(a, { type: 'reply.delta', text: 'midi.' });
    d.api.chat.relay(a, { type: 'reply.done', text: 'Il est midi.' });
    expect(d.chatWindow.moveTop).toHaveBeenCalledTimes(2);
    // Avec le focus (l'utilisateur est dedans) ou réduite : rien à faire.
    d.chatWindow.state.focused = true;
    d.api.chat.relay(a, { type: 'transcript', text: 'Merci', final: true });
    d.chatWindow.state.focused = false; d.chatWindow.state.minimized = true;
    d.api.chat.relay(a, { type: 'transcript', text: 'Encore', final: true });
    expect(d.chatWindow.moveTop).toHaveBeenCalledTimes(2);
  });
  it("Floppy se met à écouter : la conversation ouverte repasse devant sans focus et sa page l'apprend", () => {
    const d = desktop();
    d.api.chat.setState('listening');                       // fenêtre fermée : rien ne s'ouvre
    expect(d.windows).not.toHaveBeenCalled();
    d.api.chat.open(); d.chatWindow.webContents.emit('did-finish-load'); d.chatWindow.emit('ready-to-show');
    expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:init', expect.objectContaining({ state: 'listening' }));
    d.chatWindow.moveTop.mockClear(); d.front.mockClear();
    d.api.chat.setState('thinking');
    expect(d.chatWindow.webContents.send).toHaveBeenLastCalledWith('chat:state', 'thinking');
    expect(d.chatWindow.moveTop).not.toHaveBeenCalled();
    d.api.chat.setState('idle'); d.api.chat.setState('listening'); d.api.chat.setState('listening');
    expect(d.chatWindow.webContents.send).toHaveBeenLastCalledWith('chat:state', 'listening');
    expect(d.chatWindow.moveTop).toHaveBeenCalledOnce();
    expect(d.front).not.toHaveBeenCalled();
    expect(readFileSync(new URL('../src/ipc.ts', import.meta.url), 'utf8')).toContain('deps.chat().setState(s)');
    // Le bouton « arrêter l'écoute » de la fenêtre : accepté d'elle seule, pendant l'écoute seulement, et relayé à l'avatar.
    const a = connectAvatar(d);
    const send = d.avatarWindow.webContents.send;
    send.mockClear();
    expect(d.api.chat.stopListening(a)).toBe(false);
    expect(send).not.toHaveBeenCalledWith('chat-stop-listening');
    expect(d.api.chat.stopListening({ sender: d.chatWindow.webContents })).toBe(true);
    expect(send).toHaveBeenCalledWith('chat-stop-listening');
    d.api.chat.setState('idle'); send.mockClear();
    expect(d.api.chat.stopListening({ sender: d.chatWindow.webContents })).toBe(false);
    expect(send).not.toHaveBeenCalledWith('chat-stop-listening');
  });
  it("l'ouverture par l'utilisateur gagne sur celle de Floppy tant que la page charge", () => {
    const d = open({ type: 'choice.request', id: 'c1', title: '?', options: [{ id: 'x', label: 'X' }], ttl_s: 30 });
    d.api.chat.open();
    d.chatWindow.emit('ready-to-show');
    expect(d.front).toHaveBeenCalledWith(d.chatWindow);
    expect(d.chatWindow.webContents.send).toHaveBeenCalledWith('chat:focus');
  });
});

it("la conversation suit l'avatar, sauf si l'utilisateur l'a déplacée ou redimensionnée, jusqu'à sa fermeture", () => {
  const d = desktop(); d.api.createWindow();
  d.api.chat.open(); d.chatWindow.emit('ready-to-show');
  const set = d.chatWindow.setBounds;
  d.avatarBounds.x = 400; d.avatarWindow.emit('move');
  expect(set).toHaveBeenLastCalledWith({ x: 300, y: 274, width: 420, height: 520 });
  // Un écart de quelques pixels (arrondis de l'écran) n'est pas un geste de l'utilisateur.
  d.chatWindow.getBounds = () => ({ x: 301, y: 273, width: 420, height: 520 });
  d.avatarBounds.x = 500; d.avatarWindow.emit('move');
  expect(set).toHaveBeenLastCalledWith({ x: 400, y: 274, width: 420, height: 520 });
  // L'utilisateur déplace la fenêtre : elle reste où il l'a mise.
  d.chatWindow.getBounds = () => ({ x: 50, y: 60, width: 500, height: 400 });
  const calls = set.mock.calls.length;
  d.avatarBounds.x = 800; d.avatarWindow.emit('move');
  d.avatarBounds.x = 900; d.avatarWindow.emit('move');
  expect(set.mock.calls.length).toBe(calls);
  // Fermée, elle ne suit plus ; rouverte, elle repart du bon pied.
  d.chatWindow.emit('closed');
  d.avatarWindow.emit('move');
  expect(set.mock.calls.length).toBe(calls);
  d.api.chat.open();
  expect(set).toHaveBeenLastCalledWith({ x: 800, y: 274, width: 420, height: 520 });
  d.avatarBounds.x = 600; d.avatarWindow.emit('move');
  expect(set).toHaveBeenLastCalledWith({ x: 500, y: 274, width: 420, height: 520 });
});

it("redimensionnée à la main, la fenêtre garde aussi sa taille", () => {
  const d = desktop(); d.api.createWindow();
  d.api.chat.open(); d.chatWindow.emit('ready-to-show');
  const calls = d.chatWindow.setBounds.mock.calls.length;
  d.chatWindow.getBounds = () => ({ x: 1488, y: 274, width: 600, height: 520 });
  d.avatarBounds.x = 100; d.avatarWindow.emit('move');
  expect(d.chatWindow.setBounds.mock.calls.length).toBe(calls);
});

it("déplacée à la main, la conversation ne revient pas à sa place quand on la rouvre ou que Floppy la montre", () => {
  const d = desktop(); d.api.createWindow();
  d.api.chat.open(); d.chatWindow.emit('ready-to-show');
  const calls = d.chatWindow.setBounds.mock.calls.length;
  // L'avatar n'a pas bougé depuis : le geste de l'utilisateur se voit quand même à la réouverture.
  d.chatWindow.getBounds = () => ({ x: 50, y: 60, width: 420, height: 520 });
  d.api.chat.open();
  d.api.chat.show();
  expect(d.chatWindow.setBounds.mock.calls.length).toBe(calls);
});

it("la page de l'avatar rechargée réapprend que la conversation est ouverte", () => {
  const d = desktop(); d.api.createWindow();
  d.avatarWindow.webContents.emit('did-finish-load');
  d.api.chat.open(); d.chatWindow.emit('ready-to-show');
  const send = d.avatarWindow.webContents.send;
  send.mockClear();
  d.avatarWindow.webContents.emit('did-finish-load');
  expect(send).toHaveBeenCalledWith('chat-open', true);
});

it("la bulle de l'avatar s'efface tant que la conversation est visible, et revient fermée, cachée ou réduite", () => {
  const d = desktop(); d.api.createWindow();
  d.avatarWindow.webContents.emit('did-finish-load');
  const state = () => d.avatarWindow.webContents.send.mock.calls.filter((c: unknown[]) => c[0] === 'chat-open').map((c: unknown[]) => c[1]);
  d.api.chat.open();
  expect(state()).toEqual([]);                                  // pas encore montrée
  d.chatWindow.emit('ready-to-show');
  expect(state()).toEqual([true]);
  d.chatWindow.state.minimized = true; d.chatWindow.emit('minimize');
  d.chatWindow.state.minimized = false; d.chatWindow.emit('restore');
  d.chatWindow.state.visible = false; d.chatWindow.emit('hide');
  d.chatWindow.state.visible = true; d.chatWindow.emit('show');
  d.chatWindow.emit('show');                                    // rien n'a changé : rien n'est renvoyé
  expect(state()).toEqual([true, false, true, false, true]);
  d.chatWindow.emit('closed');
  expect(state()).toEqual([true, false, true, false, true, false]);
});

it('ignore un affichage reçu pour une fenêtre déjà détruite',()=>{
  const d=desktop();
  d.api.createWindow();
  Object.assign(d.avatarWindow,{isDestroyed:()=>true,setAlwaysOnTop(){throw new Error('Object has been destroyed');}});
  expect(()=>d.api.applyDisplay({avatar_visible:true})).not.toThrow();
});

it('ignore les messages du noyau après le début de la fermeture',()=>{
  const d=desktop();
  d.api.startKernel();
  const preventDefault=vi.fn();
  d.events.emit('before-quit',{preventDefault});
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(d.child.postMessage).toHaveBeenCalledWith({type:'stop'});
  expect(d.app.quit).not.toHaveBeenCalled();
  d.api.createWindow();
  Object.assign(d.avatarWindow,{isDestroyed:()=>true,setAlwaysOnTop(){throw new Error('Object has been destroyed');}});
  expect(()=>d.child.emit('message',{type:'display',settings:{avatar_visible:true}})).not.toThrow();
  d.child.emit('exit',0);
  expect(d.app.quit).toHaveBeenCalledOnce();
});

it("la réponse d'une opération des réglages garde son son (data:audio), et rien d'autre",()=>{
  const d=desktop();
  d.api.startKernel();
  const got: unknown[] = [];
  d.api.pending().set(1,(r: unknown)=>got.push(r));
  d.api.pending().set(2,(r: unknown)=>got.push(r));
  d.child.emit('message',{type:'items.result',reqId:1,ok:true,text:'ok',audio:'data:audio/wav;base64,AA=='});
  d.child.emit('message',{type:'items.result',reqId:2,ok:true,text:'ok',audio:'javascript:alert(1)'});
  expect(got[0]).toMatchObject({ok:true,audio:'data:audio/wav;base64,AA=='});
  expect(got[1]).not.toHaveProperty('audio');
});

it('--dev-plugin : passe les dossiers de debug au noyau (FLOPPY_DEV_PLUGINS)',()=>{
  expect(desktop().env.FLOPPY_DEV_PLUGINS).toBeUndefined();
  const d=desktop(['electron','.','--dev-plugin','plug-a','--dev-plugin=plug-b']);
  expect(d.env.FLOPPY_DEV_PLUGINS).toBe([resolve('plug-a'),resolve('plug-b')].join(delimiter));
});

it('relance le noyau avec une attente qui grandit, puis arrête après 5 pannes en 2 minutes',()=>{
  const { restartDelay } = desktop().api;
  const t0 = 1_000_000;
  expect(restartDelay([t0], t0)).toBe(2000);
  expect(restartDelay([t0, t0 + 1], t0 + 1)).toBe(5000);
  expect(restartDelay([t0, t0 + 1, t0 + 2], t0 + 2)).toBe(15000);
  expect(restartDelay([t0, t0 + 1, t0 + 2, t0 + 3], t0 + 3)).toBe(60000);
  expect(restartDelay([t0, t0 + 1, t0 + 2, t0 + 3, t0 + 4], t0 + 4)).toBeNull();
  // Des pannes anciennes (plus de 2 minutes) ne comptent plus.
  expect(restartDelay([t0, t0 + 1, t0 + 2, t0 + 3, t0 + 200_000], t0 + 200_000)).toBe(2000);
});

it("un démarrage impossible devient un problème visible, et la relance s'arrête après trop de pannes",()=>{
  const d=desktop();
  const relaunches = () => d.timers.mock.calls.filter((c) => [2000, 5000, 15000, 60000].includes(c[1] as number));
  d.api.startKernel();
  // Chaque noyau rate son démarrage : il envoie la raison, puis s'arrête ; l'app le relance après l'attente prévue.
  for (let i=0;i<4;i++) {
    d.child.emit('message',{type:'kernel.failed',text:{fr:'config invalide',en:'invalid config'}});
    d.child.emit('exit',2);
    expect(relaunches()).toHaveLength(i+1);
    (relaunches().at(-1)![0] as () => void)(); // l'attente est finie : nouveau noyau
  }
  expect(relaunches().map((c) => c[1])).toEqual([2000, 5000, 15000, 60000]);
  // 5e panne en moins de 2 minutes : plus de relance, et la raison reste visible.
  d.child.emit('message',{type:'kernel.failed',text:{fr:'config invalide',en:'invalid config'}});
  const timersBefore = d.timers.mock.calls.length;
  d.child.emit('exit',2);
  expect(d.timers.mock.calls.length).toBe(timersBefore); // aucune relance programmée
  expect(relaunches()).toHaveLength(4);
  expect(d.forked).toHaveLength(5);
  expect(d.api.problems().get('kernel')).toEqual({fr:'config invalide',en:'invalid config'});
});

it("le message `display` du noyau (champs en anglais) règle la fenêtre, passe les raccourcis et arrive tel quel à la page", () => {
  const d = desktop();
  d.api.createWindow();
  d.avatarWindow.webContents.send.mockClear();
  d.api.applyDisplay({ avatar_visible: true, hide_after: 3, bubble: false, always_on_top: false, autostart: false, shortcuts: { talk: 'Ctrl+Alt+G' } });
  expect(d.avatarWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
  expect(d.shortcut.register).toHaveBeenCalledWith('Ctrl+Alt+G', expect.any(Function));
  expect(d.avatarWindow.webContents.send).toHaveBeenCalledWith('display', expect.objectContaining({ hide_after: 3, bubble: false, always_on_top: false, shortcuts: { talk: 'Ctrl+Alt+G' } }));
});

it("la liste de documents venue de la page de l'avatar est nettoyée sous ses noms anglais (`title`)", () => {
  const d = desktop();
  expect(d.api.cleanDocList([
    { id: 'a1', title: 'Un'.repeat(200), date: '2026-11-06', tags: ['watch', 3] },
    { id: '../evil', title: 'x' },
    { id: 'b2', titre: 'ancien nom' },
  ])).toEqual([
    { id: 'a1', title: 'Un'.repeat(200).slice(0, 200), date: '2026-11-06', tags: ['watch', '3'] },
    { id: 'b2', title: '', date: '', tags: [] },
  ]);
  expect(d.api.cleanDocList('pas une liste')).toEqual([]);
});
