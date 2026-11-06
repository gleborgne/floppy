// Diagnostic local : aucun son joué, aucun secret écrit dans le rapport.
// VOICE_TOKEN est le jeton éphémère du service local, jamais une clé de fournisseur.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const ws = new WebSocket(`ws://127.0.0.1:8760/stream?token=${encodeURIComponent(process.env.VOICE_TOKEN ?? '')}`);
const start = performance.now();
const chunks = [];
let head = 0;
let first;
let completed = 0;
const sentences = process.argv.includes('--sentences')
  ? ['Bonjour.', 'Je vérifie la continuité de la synthèse vocale.', 'Cette phrase permet de mesurer les coupures pendant la lecture du son.']
  : ['Bonjour. Je vérifie la continuité de la synthèse vocale. Cette phrase permet de mesurer les coupures pendant la lecture du son.'];
const timeout = setTimeout(() => { console.error('Synthèse non terminée après 90 secondes'); ws.terminate(); process.exitCode = 1; }, 90_000);
ws.on('open', () => sentences.forEach((text,i)=>ws.send(JSON.stringify({type:'speak',id:`timing-probe-${i}`,text}))));
ws.on('message', (data,binary) => {
  const at = (performance.now()-start)/1000;
  if (binary) {
    const rate = data.readUInt32LE(0);
    const duration = (data.length-4)/2/rate;
    first ??= at;
    const gap = chunks.length ? Math.max(0,at+.04-head) : 0;
    head = Math.max(head,at+.04)+duration;
    chunks.push({at,duration,gap});
  } else {
    const m=JSON.parse(data.toString());
    if(m.type==='speak_done' && ++completed===sentences.length) {
      clearTimeout(timeout);
      const report={firstAudio:first,elapsed:at,audioSeconds:chunks.reduce((n,c)=>n+c.duration,0),gaps:chunks.filter(c=>c.gap>.005),chunks,error:m.error};
      writeFileSync(`out/voice-timing${sentences.length>1?'-sentences':''}.json`,JSON.stringify(report,null,2));
      console.log(JSON.stringify({...report,chunks:chunks.length}));
      ws.close();
    }
  }
});
ws.on('error', e=>{clearTimeout(timeout);console.error(e.message);process.exitCode=1;});
