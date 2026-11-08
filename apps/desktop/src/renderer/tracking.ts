import { startTracking } from "./tracking-view.ts";

const bridge = window.floppyDesktop;
if (!bridge) throw new Error("desktop.bridge-unavailable");
const stop = startTracking(document.getElementById("tracking")!, {
  get: () => bridge.get() as Promise<TrackingPayload | null>,
  refresh: () => bridge.action("refresh") as Promise<{ ok: boolean }>,
  onUpdate: (fn) => bridge.onUpdate((payload) => fn(payload as TrackingPayload)),
});
window.addEventListener("pagehide", stop, { once: true });
