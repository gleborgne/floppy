import type { Context } from "@floppy/core";
import type { DesktopContent, DesktopContribution, DesktopRegistration } from "@floppy/contracts";
import { randomUUID } from "node:crypto";

/** Les écouteurs, abonnements, demandes en cours et l'inscription vivent exactement avec ctx. */
export function registerDesktop(ctx: Pick<Context, "id" | "host" | "effect" | "on">, contribution: DesktopContribution, content: DesktopContent) {
  const host = ctx.host;
  if (!host) return;
  const token = randomUUID();
  const active = new Set<AbortController>();
  let stopped = false;
  const send = (data: object) => { if (!stopped) host.postMessage({ ...data, owner: ctx.id, id: contribution.id, token }); };
  const publish = () => {
    try { send({ type: "desktop.update", snapshot: content.snapshot?.() }); }
    catch { send({ type: "desktop.failure", reason: "snapshot.failed" }); }
  };
  const listener = (e: { data: unknown }) => {
    const m = e.data as { type?: string; owner?: string; id?: string; token?: string; action?: string; reqId?: number };
    if (stopped || m?.type !== "desktop.request" || m.owner !== ctx.id || m.id !== contribution.id || m.token !== token) return;
    if (m.action === "$snapshot") { publish(); return; }
    const action = m.action && Object.hasOwn(content.actions ?? {}, m.action) ? content.actions?.[m.action] : undefined;
    if (!action) { send({ type: "desktop.result", reqId: m.reqId, ok: false }); return; }
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(), 10_000);
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    void Promise.race([Promise.resolve().then(() => { if (stopped || controller.signal.aborted) throw new Error("cancelled"); return action(controller.signal); }), cancelled]).then(
      (value) => send({ type: "desktop.result", reqId: m.reqId, ok: true, value }),
      () => { send({ type: "desktop.failure", reason: "action.failed" }); send({ type: "desktop.result", reqId: m.reqId, ok: false }); },
    ).finally(() => { clearTimeout(timer); active.delete(controller); });
  };
  host.on("message", listener);
  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try { unsubscribe?.(); } finally {
      for (const controller of active) controller.abort();
      (host.off ?? host.removeListener)?.call(host, "message", listener);
    }
  };
  const unregister = () => {
    if (stopped) return;
    try { send({ type: "desktop.remove" }); } finally { cleanup(); }
  };
  ctx.on("plugin.state", (state) => { if (state.id === ctx.id && state.state === "stopping") unregister(); });
  ctx.effect(cleanup);
  send({ type: "desktop.register", contribution: { ...contribution, owner: ctx.id, token, actions: Object.keys(content.actions ?? {}) } satisfies DesktopRegistration });
  unsubscribe = content.subscribe?.(publish);
  publish();
  return unregister;
}
