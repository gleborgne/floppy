import { describe, it, expect } from "vitest";
// @ts-expect-error module .mjs sans types
import { renderMarkdown } from "../src/markdown.mjs";

const render = (s: string): string => renderMarkdown(s);

describe("rendu Markdown", () => {
  it("titres, listes, gras", () => {
    const h = render("# Titre\n\n- un\n- **deux**");
    expect(h).toContain("<h1>Titre</h1>");
    expect(h).toContain("<li><strong>deux</strong></li>");
  });

  it("tableaux", () => {
    const h = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(h).toContain("<table>");
    expect(h).toContain("<th>a</th>");
    expect(h).toContain("<td>2</td>");
  });

  it("le HTML brut est échappé", () => {
    const h = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
  });

  it("liens http(s) et mailto gardés, avec rel", () => {
    const h = render("[a](https://exemple.fr/x) [b](mailto:a@b.fr)");
    expect(h).toContain('href="https://exemple.fr/x"');
    expect(h).toContain('href="mailto:a@b.fr"');
    expect(h).toContain('rel="noopener noreferrer"');
  });

  it("javascript:, data:, file: ne deviennent pas des liens", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "file:///c:/x", "vbscript:x"]) {
      const h = render(`[clic](${u})`);
      expect(h, u).not.toContain("<a ");
      expect(h, u).not.toContain("href=");
    }
  });

  it("images : pas d'attribut src dangereux", () => {
    const h = render("![x](javascript:alert(1))");
    expect(h).not.toContain("javascript:alert(1)\"");
  });

  it("adresse seule : lien automatique", () => {
    expect(render("voir https://exemple.fr/a")).toContain('<a href="https://exemple.fr/a"');
  });
});
