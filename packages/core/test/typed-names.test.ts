// Les noms de services, de hooks et d'événements sont vérifiés par le compilateur : un nom mal écrit ne compile pas.
// Ce fichier est dans `npm run typecheck` : chaque `@ts-expect-error` échoue s'il n'y a plus d'erreur à la ligne suivante.
// Les `expectTypeOf` vérifient que les types d'un hook et d'un événement sont déduits de son nom.
import { describe, it, expect, expectTypeOf } from "vitest";
import { Bus, definePlugin, type ApprovalRequest, type Context, type Hooks, type ToolCallInput, type ToolResult } from "../src/index.ts";

// Un service, un hook et un événement à soi : même chemin pour un plugin du dépôt (« @floppy/core ») ; un plugin
// personnel augmente de la même façon les interfaces de floppy-plugin.d.ts (voir docs/spec/plugins-tiers.md).
declare module "../src/index.ts" {
  interface Services { "demo.compteur": { suivant(): number } }
  interface HookTypes { "demo.avant": { input: { n: number }; output: string } }
  interface CoreEvents { "demo.tic": { fois: number } }
}

/** Jamais exécutée : seule la vérification des types compte. */
function nomsDeServices(ctx: Context) {
  ctx.get("brain");
  // @ts-expect-error « ttts » n'est pas un service
  ctx.get("ttts");
  // @ts-expect-error nom inconnu
  ctx.maybe("memorry");
  // @ts-expect-error nom inconnu
  ctx.use("nope");
  // @ts-expect-error nom inconnu
  ctx.provide("nope", 1);
  // @ts-expect-error nom inconnu
  ctx.offers("nope");
  // @ts-expect-error nom inconnu
  ctx.borrowItem("nope", "x");
  // @ts-expect-error nom inconnu
  ctx.restartOffers("nope");
  ctx.offers("notify");
  // Le type du service vient de son nom.
  expectTypeOf(ctx.get("demo.compteur").suivant()).toEqualTypeOf<number>();
  // @ts-expect-error mauvais type pour ce service
  ctx.provide("demo.compteur", { suivant: "non" });

  definePlugin({
    // @ts-expect-error « optionnal » : champ inconnu du manifeste (le noyau le refuse aussi à l'exécution)
    manifest: { id: "p", version: "0", licence: "MIT", optionnal: ["memory"] },
    apply() {},
  });
  definePlugin({
    // @ts-expect-error « ttts » n'est pas un service (provides)
    manifest: { id: "p", version: "0", licence: "MIT", provides: ["ttts"] },
    apply() {},
  });
  definePlugin({
    // @ts-expect-error « memorry » n'est pas un service (inject)
    manifest: { id: "p", version: "0", licence: "MIT", inject: ["memorry"] },
    apply() {},
  });
  definePlugin({
    // @ts-expect-error « llmm » n'est pas un service (slots[].service)
    manifest: { id: "p", version: "0", licence: "MIT", slots: [{ id: "a.b", service: "llmm", section: "s", label: "L" }] },
    apply() {},
  });
  definePlugin({ manifest: { id: "p", version: "0", licence: "MIT", provides: ["demo.compteur"], inject: ["brain"], optional: ["memory"] }, apply() {} });
}

function nomsDEvenements(ctx: Context, bus: Bus) {
  // @ts-expect-error « aproval.request » n'est pas un événement
  ctx.on("aproval.request", () => {});
  // @ts-expect-error nom inconnu
  ctx.emit("nope", {});
  // @ts-expect-error nom inconnu
  bus.on("plugin.stat", () => {});
  // @ts-expect-error nom inconnu
  bus.emit("nope", 1);
  // La charge utile vient du nom.
  ctx.on("approval.request", (r) => { expectTypeOf(r).toEqualTypeOf<ApprovalRequest>(); });
  ctx.on("demo.tic", (p) => { expectTypeOf(p).toEqualTypeOf<{ fois: number }>(); });
  // @ts-expect-error mauvaise charge utile
  ctx.emit("demo.tic", { fois: "deux" });
  ctx.emit("demo.tic", { fois: 2 });
}

function nomsDeHooks(ctx: Context, hooks: Hooks) {
  // @ts-expect-error « tool.befor » n'est pas un hook
  ctx.hook("tool.befor", async (i, next) => next(i));
  // @ts-expect-error nom inconnu
  ctx.runHook("nope", 1, async () => 1);
  // @ts-expect-error nom inconnu
  hooks.run("nope", 1, async () => 1);
  // Entrée et sortie déduites du nom, sans type donné à l'appel.
  ctx.hook("tool.before", async (input, next) => {
    expectTypeOf(input).toEqualTypeOf<ToolCallInput>();
    const r = await next(input);
    expectTypeOf(r).toEqualTypeOf<ToolResult>();
    return r;
  });
  // @ts-expect-error la sortie de tool.before est un ToolResult
  ctx.hook("tool.before", async () => 5);
  const rendu = ctx.runHook("tool.before", {} as ToolCallInput, async () => ({ status: "done" as const, text: "ok" }));
  expectTypeOf(rendu).toEqualTypeOf<Promise<ToolResult>>();
  // @ts-expect-error mauvaise entrée
  ctx.runHook("tool.before", { name: 1 }, async () => ({ status: "done", text: "ok" }));
  // Hooks des contrats (déclarés par leur domaine).
  ctx.hook("conversation.command", async (input, next) => {
    expectTypeOf(input).toEqualTypeOf<{ text: string; origin: string }>();
    return next(input);
  });
  ctx.hook("initiative.presented", async (e, next) => { expectTypeOf(e.stage).toBeString(); await next(e); });
  ctx.hook("demo.avant", async (input, next) => { expectTypeOf(input.n).toBeNumber(); return next(input); });
  expectTypeOf(ctx.runHook("demo.avant", { n: 1 }, async () => "x")).toEqualTypeOf<Promise<string>>();
}

describe("noms vérifiés par le compilateur", () => {
  it("les erreurs de nom sont attrapées par `npm run typecheck` (voir les @ts-expect-error)", () => {
    expect([nomsDeServices, nomsDEvenements, nomsDeHooks].every((f) => typeof f === "function")).toBe(true);
  });
});
