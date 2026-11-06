// Test de connexion avec le compte configuré, sans microphone ni appel d'outil.
import { Kernel, type LiveService } from '@floppy/core';
import gemini from '../plugins/live/gemini/src/index.ts';
import { join } from 'node:path';
const k = new Kernel({ home: join(process.env.LOCALAPPDATA!, 'floppy'), logger: () => {}, plugins: [gemini] });
try {
  await k.applyConfig({ plugins: [{ id: 'live-gemini', plugin: 'live-gemini' }], services: { live: 'live-gemini' } });
  const session = await k.service<LiveService>('live')!.open({ body: 'diagnostic', instructions: 'Test de connexion. Attends en silence.', tools: [], signal: AbortSignal.timeout(20000), on: e => { if(e.type==='error') console.log(e.message); } });
  console.log('Gemini Live : session ouverte.');
  await session.close();
} catch (e) { console.error(e instanceof Error ? e.message : 'Échec Gemini Live'); process.exitCode=1; }
finally { await k.stopAll(); }
