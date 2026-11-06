type R = { node: string; ts: boolean };
process.parentPort.once("message", (e: Electron.MessageEvent) => {
  const r: R = { node: process.versions.node, ts: true };
  e.ports[0]!.postMessage({ ...r, ok: true });
});
