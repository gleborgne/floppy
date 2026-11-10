// Le SDK ne doit pas dériver du noyau : ce que floppy-plugin.d.ts promet, le ctx du noyau le donne.
// Ces affectations échouent à `npm run typecheck` si les deux divergent.
import { describe, it, expect } from "vitest";
import type { Context, SettingDef as CoreSettingDef, ToolOutput as CoreToolResult, Services as CoreServices } from "@floppy/core";
import type { PluginContext, SettingDef, ToolResult, UserPlugin, Services } from "../floppy-plugin.d.ts";
import timer from "../examples/timer/index.ts";
import weather from "../examples/weather/index.ts";

const ctxFits = (c: Context): PluginContext => c;
const settingFits = (s: SettingDef): CoreSettingDef => s;
const resultFits = (r: ToolResult): CoreToolResult => r;
// Ce que le noyau fournit doit tenir dans les contrats promis par le SDK.
const servicesFit = (s: Pick<CoreServices, keyof Services>): Services => s;
const examples: UserPlugin[] = [timer, weather];

describe("SDK des plugins", () => {
  it("les types suivent le noyau ; les exemples sont des UserPlugin", () => {
    expect([ctxFits, settingFits, resultFits, servicesFit].every((f) => typeof f === "function")).toBe(true);
    expect(examples.map((e) => e.manifest.id)).toEqual(["timer", "weather"]);
  });
});
