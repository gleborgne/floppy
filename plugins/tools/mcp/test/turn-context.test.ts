import { describe, expect, it } from "vitest";
import { TurnContexts } from "../src/turn-context.ts";

describe("contexte MCP lié au tour par l'hôte", () => {
  it("accepte des liaisons imbriquées identiques et retire le contexte à leur fermeture", () => {
    const contexts = new TurnContexts();
    const outer = contexts.bind({ session: "avatar", origin: "avatar" });
    const inner = contexts.bind({ session: "avatar", origin: "avatar" });
    expect(contexts.snapshot()).toMatchObject({ session: "avatar", origin: "avatar" });
    inner();
    expect(contexts.snapshot()?.session).toBe("avatar");
    const snapshot = contexts.snapshot()!;
    outer();
    expect(snapshot.signal?.aborted).toBe(true);
    expect(contexts.snapshot()).toBeUndefined();
  });

  it("ne confond pas deux tours concurrents de la même conversation", () => {
    const contexts = new TurnContexts();
    const first = contexts.bind({ session: "avatar", origin: "avatar", turn: "1" });
    const second = contexts.bind({ session: "avatar", origin: "avatar", turn: "2" });
    expect(contexts.snapshot()).toBeUndefined();
    first();
    expect(contexts.snapshot()?.turn).toBe("2");
    second();
  });

  it("ne prête pas la session d'un autre tour lorsque le jeton est partagé", () => {
    const contexts = new TurnContexts();
    contexts.bind({ session: "avatar", origin: "avatar" });
    const other = contexts.bind({ session: "chat", origin: "chat" });
    expect(contexts.snapshot()).toBeUndefined();
    other();
    expect(contexts.snapshot()?.session).toBe("avatar");
    const conflict = contexts.bind({ session: "avatar", origin: "autre" });
    expect(contexts.snapshot()).toBeUndefined();
    conflict(); contexts.close();
    expect(contexts.snapshot()).toBeUndefined();
  });

  it("annule la liaison avec le tour et nettoie les demandes actives à l'arrêt", () => {
    const contexts = new TurnContexts();
    const stop = new AbortController();
    contexts.bind({ session: "avatar", signal: stop.signal });
    const snapshot = contexts.snapshot()!;
    stop.abort();
    expect(snapshot.signal?.aborted).toBe(true);
    expect(contexts.snapshot()).toBeUndefined();
    contexts.bind({ session: "deja-annule", signal: stop.signal });
    expect(contexts.snapshot()).toBeUndefined();
    contexts.bind({ session: "nouveau" });
    const next = contexts.snapshot()!;
    contexts.close();
    expect(next.signal?.aborted).toBe(true);
  });
});
