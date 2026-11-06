// Spike P0 : le noyau peut-il tourner dans un utilityProcess d'Electron ?
// Vérifie : version de Node, node:sqlite + FTS5, lancement d'un processus enfant, MessagePort.
import { app, utilityProcess, MessageChannelMain } from "electron";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
app.whenReady().then(() => {
  const child = utilityProcess.fork(join(here, "core-ts.ts"), [], { stdio: "inherit" });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: "port" }, [port2]);
  port1.on("message", (e) => { console.log("MAIN reçu :", JSON.stringify(e.data)); app.exit(e.data.ok ? 0 : 1); });
  port1.start();
  setTimeout(() => { console.log("MAIN : délai dépassé"); app.exit(2); }, 20000);
});
