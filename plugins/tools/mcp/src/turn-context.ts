// Le transport MCP ne connaît pas les sessions vocales. L'hôte les lie à son jeton le temps du tour.
import type { McpTurnContext } from "@floppy/contracts";

export class TurnContexts {
  private leases = new Map<symbol, McpTurnContext>();
  private releases = new Set<() => void>();

  bind(context: McpTurnContext): () => void {
    const key = Symbol();
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    this.leases.set(key, { ...context, signal });
    const release = () => {
      this.leases.delete(key);
      this.releases.delete(release);
      context.signal?.removeEventListener("abort", release);
      controller.abort();
    };
    this.releases.add(release);
    context.signal?.addEventListener("abort", release, { once: true });
    if (context.signal?.aborted) release();
    return release;
  }

  snapshot(): McpTurnContext | undefined {
    const active = [...this.leases.values()];
    const first = active[0];
    if (!first || active.some(c => c.session !== first.session || c.origin !== first.origin || c.turn !== first.turn)) return;
    return { ...first, signal: AbortSignal.any(active.map(c => c.signal!)) };
  }

  close(): void { for (const release of [...this.releases]) release(); }
}
