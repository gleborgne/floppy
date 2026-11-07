// Surveillance d'un serveur local : onDead après plusieurs vérifications ratées d'affilée, une seule fois.
import { describe, it, expect } from "vitest";
import { EffectScope, watchHealth } from "../src/index.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("surveillance d'un serveur", () => {
  it("une réponse remet le compte à zéro ; trois ratés d'affilée appellent onDead une fois", async () => {
    const answers = [false, true, false, false, false, false, false];
    const dead: number[] = [];
    const scope = new EffectScope();
    watchHealth({ effect: (d) => scope.add(d) }, { everyMs: 5, check: async () => answers.shift() ?? false, onDead: (n) => dead.push(n) });
    await wait(120);
    expect(dead).toEqual([3]);
    await scope.dispose();
  });

  it("s'arrête avec le plugin", async () => {
    let checks = 0;
    const scope = new EffectScope();
    watchHealth({ effect: (d) => scope.add(d) }, { everyMs: 5, check: async () => { checks++; return true; }, onDead: () => {} });
    await wait(30);
    await scope.dispose();
    const seen = checks;
    await wait(30);
    expect(checks).toBe(seen);
  });
});
