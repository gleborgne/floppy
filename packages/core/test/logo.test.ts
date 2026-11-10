import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanLogo, definePlugin, glyphLogo, imageLogo, Kernel, LOGO_MAX, svgLogo, type Logo } from "../src/index.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("logos", () => {
  it("garde seulement des images data: d'un type connu et de taille bornée", () => {
    expect(imageLogo(PNG)).toBe(PNG);
    expect(imageLogo("data:image/svg+xml;base64,PHN2Zy8+")).toBeDefined();
    expect(imageLogo("https://contoso.com/logo.png")).toBeUndefined();
    expect(imageLogo("data:text/html;base64,PGgxPg==")).toBeUndefined();
    expect(imageLogo(`data:image/png;base64,${"A".repeat(LOGO_MAX)}`)).toBeUndefined();
    expect(imageLogo(42)).toBeUndefined();
  });

  it("svgLogo et glyphLogo donnent un SVG à la couleur de la marque", () => {
    const g = glyphLogo("M0 0h24v24H0z", "#7C3AED");
    expect(g.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(g.split(",")[1]!, "base64").toString()).toContain('fill="#7C3AED"');
    expect(svgLogo(" <svg/> ")).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
  });

  it("cleanLogo : image, programme ou protocole ; le reste est ignoré", () => {
    expect(cleanLogo(PNG)).toBe(PNG);
    expect(cleanLogo({ program: " C:/Programs/contoso/contoso.exe " })).toEqual({ program: "C:/Programs/contoso/contoso.exe" });
    expect(cleanLogo({ handler: "HTTPS" })).toEqual({ handler: "https" });
    expect(cleanLogo({ handler: "https://x" })).toBeUndefined();
    expect(cleanLogo({ program: "" })).toBeUndefined();
    expect(cleanLogo("javascript:alert(1)")).toBeUndefined();
  });

  it("élément Application : logo du manifeste, remplacé par ctx.items.logo (null = aucun), celui du manifeste une fois éteint", async () => {
    let given: Logo | null | undefined;
    const plugin = definePlugin({
      manifest: { id: "contoso", version: "0.0.1", licence: "MIT", addable: { section: "connectors", label: "Contoso", logo: PNG } },
      apply(ctx) { ctx.items.logo(given); },
    });
    const k = new Kernel({ logger: () => {}, home: mkdtempSync(join(tmpdir(), "logo-")), plugins: [plugin] });
    kernels.push(k);
    const logo = async () => (await k.items.provider("apps-connectors")!.list())[0]?.logo;

    await k.applyConfig({ plugins: [{ id: "contoso", plugin: "contoso" }] });
    expect(await logo()).toBe(PNG);

    given = { program: "C:/Programs/contoso/contoso.exe" };
    await k.applyConfig({ plugins: [{ id: "contoso", plugin: "contoso", config: { v: 1 } }] });
    expect(await logo()).toEqual({ program: "C:/Programs/contoso/contoso.exe" });

    given = null;
    await k.applyConfig({ plugins: [{ id: "contoso", plugin: "contoso", config: { v: 2 } }] });
    expect(await logo()).toBeUndefined();

    await k.items.run({ op: "enable", provider: "apps-connectors", id: "contoso", on: false }, "ui");
    expect(await logo()).toBe(PNG);
  });
});
