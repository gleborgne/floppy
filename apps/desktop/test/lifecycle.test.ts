import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';

// Le vrai processus principal, dans un bac sans Electron ni processus/fichiers réels.
function desktop() {
  const events = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  const app = { quit:vi.fn(), requestSingleInstanceLock:()=>true, commandLine:{appendSwitch(){}}, whenReady:()=>new Promise(()=>{}), on:events.on.bind(events), getAppPath:()=>'.', getLoginItemSettings:()=>({executableWillLaunchAtLogin:false}), setLoginItemSettings(){} };
  const source = readFileSync(new URL('../src/main.mjs', import.meta.url),'utf8')
    .replace(/^import .*;\r?$/gm,'').replaceAll('import.meta.url', JSON.stringify(new URL('../src/main.mjs',import.meta.url).href));
  const context: Record<string, any> = { app, globalShortcut:{unregisterAll(){}}, fileURLToPath, dirname,join,resolve, process:{env:{},chdir(){},stdout:{write(){}},execPath:'electron'},mkdirSync(){},existsSync:()=>false,renameSync(){},createWriteStream:()=>({write(){}}),setTimeout:vi.fn(()=>1),clearTimeout:vi.fn(), utilityProcess:{fork:()=>child}, console };
  runInNewContext(source+';globalThis.api={applyDisplay,startKernel,setWindow:w=>{win=w;}};',context);
  return { api:context.api,events,child,app };
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
