// Noms de services et d'événements inventés par les tests du noyau. Ils sont déclarés comme le ferait un plugin qui a
// les siens (augmentation de module) : le compilateur ne connaît que les noms déclarés, ceux-ci compris.
// Le visage de la règle (un nom mal écrit ne compile pas) est vérifié par typed-names.test.ts.
export {};

declare module "../src/index.ts" {
  interface Services {
    a: unknown;
    b: unknown;
    c: unknown;
    x: unknown;
    svc: unknown;
    testVoice: unknown;
  }
  interface HookTypes {
    t: { input: string[]; output: string[] };
    refuse: { input: number; output: number };
    apres: { input: number; output: number };
  }
  interface CoreEvents {
    x: unknown;
  }
}
