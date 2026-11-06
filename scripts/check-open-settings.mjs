// Vérification de bout en bout sur l'application locale démarrée.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
const home = join(process.env.LOCALAPPDATA, 'floppy');
const {port,token} = JSON.parse(readFileSync(join(home,'body-ws.json'),'utf8'));
const since = new Date().toISOString();
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
let reply='';
const timer=setTimeout(()=>{console.error('Pas de réponse après 60 secondes');ws.terminate();process.exitCode=1;},60000);
ws.on('open',()=>ws.send(JSON.stringify({type:'hello',id:'settings-probe',name:'Diagnostic réglages',version:'0.1.0',capabilities:['text']})));
ws.on('message',(data,binary)=>{
  if(binary)return;
  const m=JSON.parse(data.toString());
  if(m.type==='welcome')ws.send(JSON.stringify({type:'text',text:'Ouvre-moi la fenêtre de tes réglages, s’il te plaît.'}));
  if(m.type==='reply.delta')reply+=m.text;
  if(m.type==='reply.done'){
    clearTimeout(timer);
    const events=readFileSync(join(home,'audit.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
    const action=events.find(e=>e.t>=since && e.kind==='tool' && e.tool==='ouvrir_reglages');
    console.log(JSON.stringify({reply,tool:action?.tool,status:action?.status}));
    if(action?.status!=='done')process.exitCode=1;
    ws.close();
  }
});
ws.on('error',e=>{clearTimeout(timer);console.error(e.message);process.exitCode=1;});
