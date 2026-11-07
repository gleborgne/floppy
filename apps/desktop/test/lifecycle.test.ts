import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';

// Le vrai processus principal, dans un bac sans Electron ni processus/fichiers réels.
function desktop(argv: string[] = []) {
  const events = new EventEmitter();
  // Un nouveau processus du noyau à chaque lancement (comme utilityProcess.fork) ; `child` est le dernier.
  const forked: (EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> })[] = [];
  const fork = () => { const c = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }); forked.push(c); return c; };
  const app = { quit:vi.fn(), requestSingleInstanceLock:()=>true, commandLine:{appendSwitch(){}}, whenReady:()=>new Promise(()=>{}), on:events.on.bind(events), getAppPath:()=>'.', getLoginItemSettings:()=>({executableWillLaunchAtLogin:false}), setLoginItemSettings(){} };
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url),'utf8')
    .replace(/^import .*;\r?$/gm,'').replaceAll('import.meta.url', JSON.stringify(new URL('../src/main.mjs',import.meta.url).href));
  const context: Record<string, any> = { app, globalShortcut:{unregisterAll(){}}, fileURLToPath, delimiter, dirname,join,resolve, process:{env:{},argv,chdir(){},stdout:{write(){}},execPath:'electron'},mkdirSync(){},existsSync:()=>false,renameSync(){},statSync(){throw new Error('absent');},createWriteStream:()=>({write(){},on(){},end(){}}),readFileSync(){throw new Error('absent');},setTimeout:vi.fn(()=>1),clearTimeout:vi.fn(), utilityProcess:{fork}, console };
  runInNewContext(source+';globalThis.api={applyDisplay,startKernel,restartDelay,problems:()=>problems,setWindow:w=>{win=w;}};',context);
  return { api:context.api,events,get child(){ return forked.at(-1)!; },forked,app,env:context.process.env as Record<string,string>,timers:context.setTimeout as ReturnType<typeof vi.fn> };
}

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
