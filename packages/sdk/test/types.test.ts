// Le SDK ne doit pas dériver du noyau : ce que floppy-plugin.d.ts promet, le ctx du noyau le donne.
// Ces affectations échouent à `npm run typecheck` si les deux divergent.
import { describe, it, expect } from "vitest";
import type { Context, SettingDef as CoreSettingDef, ToolOutput as CoreToolResult } from "@floppy/core";
import type { PluginContext, SettingDef, ToolResult, UserPlugin } from "../floppy-plugin.d.ts";
import minuteur from "../examples/minuteur/index.ts";
import meteo from "../examples/meteo/index.ts";

const ctxFits = (c: Context): PluginContext => c;
const settingFits = (s: SettingDef): CoreSettingDef => s;
const resultFits = (r: ToolResult): CoreToolResult => r;
const examples: UserPlugin[] = [minuteur, meteo];

describe("SDK des plugins", () => {
  it("les types suivent le noyau ; les exemples sont des UserPlugin", () => {
    expect([ctxFits, settingFits, resultFits].every((f) => typeof f === "function")).toBe(true);
    expect(examples.map((e) => e.manifest.id)).toEqual(["minuteur", "meteo"]);
  });
});
