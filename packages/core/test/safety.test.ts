// Filet global : une erreur asynchrone oubliée est rapportée, le processus continue ; trop d'erreurs d'affilée arrêtent le noyau.
import { describe, it, expect } from "vitest";
import { installSafetyNet, type SafetyKind } from "../src/index.ts";

describe("filet global", () => {
  it("rapporte une promesse rejetée et une exception, puis se retire", () => {
    const seen: [SafetyKind, unknown][] = [];
    const off = installSafetyNet({ onError: (k, e) => seen.push([k, e]), exit: () => { throw new Error("pas d'arrêt attendu"); } });
    const boom = new Error("boom");
    process.emit("unhandledRejection", boom, Promise.resolve());
    process.emit("uncaughtException", boom);
    off();
    expect(seen).toEqual([["unhandledRejection", boom], ["uncaughtException", boom]]);
    expect(process.listenerCount("unhandledRejection")).toBeLessThan(10);
  });

  it("arrête le processus après trop d'exceptions en peu de temps", () => {
    const codes: number[] = [];
    const off = installSafetyNet({ onError: () => {}, maxUncaught: 3, windowMs: 60_000, exit: (c) => codes.push(c) });
    for (let i = 0; i < 3; i++) process.emit("uncaughtException", new Error(String(i)));
    off();
    expect(codes).toEqual([1]);
  });
});
