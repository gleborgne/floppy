// Le nom de l'outil de délégation (lu par le modèle et par le noyau pour dire la phrase d'attente) est « delegate ».
import { expect, it } from "vitest";
import plugin from "../src/index.ts";
import { delegateDescription } from "../src/prompt.ts";

it("réglage par défaut : delegate (l'ancien nom français n'existe plus) ; sa description nomme l'argument task", () => {
  const cfg = (plugin as unknown as { config: { parse(x: unknown): { delegateTool: string } } }).config.parse({});
  expect(cfg.delegateTool).toBe("delegate");
  expect(delegateDescription("Claude")).toContain("task :");
});
