import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import * as texts from '../src/main-texts.mjs';
import * as trayIcon from '../src/tray-icon.mjs';
import * as placement from '../src/placement.mjs';

// Le vrai processus principal, dans un bac sans Electron ni processus/fichiers réels.
function desktop(argv: string[] = []) {
  const events = new EventEmitter();
  // Un nouveau processus du noyau à chaque lancement (comme utilityProcess.fork) ; `child` est le dernier.
  const forked: (EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> })[] = [];
  const fork = () => { const c = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); forked.push(c); return c; };
  const app = { quit:vi.fn(), requestSingleInstanceLock:()=>true, commandLine:{appendSwitch(){}}, whenReady:()=>new Promise(()=>{}), on:events.on.bind(events), getAppPath:()=>'.', getLoginItemSettings:()=>({executableWillLaunchAtLogin:false}), setLoginItemSettings(){} };
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url),'utf8')
    .replace(/^import .*;\r?$/gm,'').replaceAll('import.meta.url', JSON.stringify(new URL('../src/main.mjs',import.meta.url).href));
  const textWindow = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { send: vi.fn() }), loadFile: vi.fn(), isDestroyed: () => false });
  Object.assign(app, { isReady: () => true });
  const shortcut = { unregisterAll() {}, register: vi.fn(() => true), unregister: vi.fn() };
  const context: Record<string, any> = { app, globalShortcut:{unregisterAll(){}}, fileURLToPath, delimiter, dirname,join,resolve, process:{env:{},argv,chdir(){},stdout:{write(){}},execPath:'electron'},mkdirSync(){},existsSync:()=>false,renameSync(){},statSync(){throw new Error('absent');},createWriteStream:()=>({write(){},on(){},end(){}}),readFileSync(){throw new Error('absent');},setTimeout:vi.fn(()=>1),clearTimeout:vi.fn(), utilityProcess:{fork}, console,
    // Modules du processus principal (les imports sont retirés du source) : les vrais, sauf les fenêtres (Electron).
    ...texts, ...trayIcon, ...placement, safeWindow:vi.fn(() => textWindow), bringToFront: vi.fn() };
  context.globalShortcut = shortcut;
  runInNewContext(source+';globalThis.api={applyDisplay,startKernel,restartDelay,openTextInput,submitText,applyShortcuts,problems:()=>problems,setWindow:w=>{win=w;},readyText:()=>{winReady=true;currentPorts={};},pending:()=>pending};',context);
  return { api:context.api,events,get child(){ return forked.at(-1)!; },forked,app,textWindow,shortcut,windows:context.safeWindow,front:context.bringToFront,env:context.process.env as Record<string,string>,timers:context.setTimeout as ReturnType<typeof vi.fn> };
}

it("le raccourci global ouvre la saisie, se remplace et se désactive", () => {
  const d = desktop();
  d.api.applyShortcuts({});
  const write = d.shortcut.register.mock.calls.find(c => c[0] === 'Ctrl+Alt+T')!;
  expect(write).toBeDefined();
  write[1]();
  expect(d.windows).toHaveBeenCalledOnce();
  d.api.applyShortcuts({ecrire: 'Ctrl+Shift+T'});
  expect(d.shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+T');
  expect(d.shortcut.register).toHaveBeenCalledWith('Ctrl+Shift+T', expect.any(Function));
  d.api.applyShortcuts({ecrire: ''});
  expect(d.shortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+T');
});

it("la saisie réutilise sa fenêtre et n'envoie qu'à l'avatar connecté depuis son propre expéditeur", () => {
  const d = desktop();
  d.api.openTextInput();
  d.textWindow.webContents.emit('did-finish-load');
  expect(d.textWindow.webContents.send).toHaveBeenCalledWith('text:lang', 'fr');
  d.textWindow.emit('ready-to-show');
  expect(d.front).toHaveBeenCalledWith(d.textWindow);
  d.api.openTextInput();
  expect(d.windows).toHaveBeenCalledOnce();
  expect(d.textWindow.webContents.send).toHaveBeenCalledWith('text:focus');
  const e = { sender: d.textWindow.webContents };
  expect(d.api.submitText(e, 'Bonjour')).toBe(false);
  d.api.startKernel(); d.api.readyText();
  const send = vi.fn();
  d.api.setWindow({ isDestroyed: () => false, isVisible: () => true, webContents: { send } });
  expect(d.api.submitText({sender: {}}, 'Bonjour')).toBe(false);
  for (const invalid of ['', '  ', null, 'a'.repeat(10001)]) expect(d.api.submitText(e, invalid)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(d.api.submitText(e, '  Bonjour  ')).toBe(true);
  expect(send).toHaveBeenCalledWith('text-request', 'Bonjour');
  d.textWindow.emit('closed');
  expect(d.api.submitText(e, 'Bonjour')).toBe(false);
});

it('ignore un affichage reçu pour une fenêtre déjà détruite',()=>{
  const d=desktop();
  const window={isDestroyed:()=>true,setAlwaysOnTop(){throw new Error('Object has been destroyed');}};
  d.api.setWindow(window);
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
  const window={isDestroyed:()=>true,setAlwaysOnTop(){throw new Error('Object has been destroyed');}};
  d.api.setWindow(window);
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
  expect(d.api.problems().get('noyau')).toEqual({fr:'config invalide',en:'invalid config'});
});
