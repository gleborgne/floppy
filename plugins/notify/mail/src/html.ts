// Met un texte Markdown en mail HTML lisible. Les mails ignorent souvent <style> : tout est en styles « inline ».
import MarkdownIt from "markdown-it";

const POLICE = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const LIEN = "#1a56c4";
const BORD = "#d0d7de";

const md = new MarkdownIt({ html: false, linkify: true });
// Seulement des liens web ou mail : pas de javascript:, data:, file:…
md.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());

/** Style de chaque balise (ajouté en attribut `style` à l'ouverture). */
const STYLES: Record<string, string> = {
  h1: "font-size:22px;margin:24px 0 12px;line-height:1.3",
  h2: "font-size:19px;margin:22px 0 10px;line-height:1.3",
  h3: "font-size:16px;margin:18px 0 8px;line-height:1.3",
  p: "margin:0 0 12px",
  ul: "margin:0 0 12px;padding-left:24px",
  ol: "margin:0 0 12px;padding-left:24px",
  blockquote: `margin:0 0 12px;padding:2px 14px;border-left:4px solid ${BORD};color:#57606a`,
  table: `border-collapse:collapse;margin:0 0 14px;border:1px solid ${BORD}`,
  th: `border:1px solid ${BORD};padding:6px 10px;background:#f6f8fa;text-align:left`,
  td: `border:1px solid ${BORD};padding:6px 10px;vertical-align:top`,
  a: `color:${LIEN};text-decoration:underline`,
  code: "font-family:Consolas,Menlo,monospace;font-size:90%;background:#f6f8fa;padding:1px 4px;border-radius:3px",
  hr: `border:0;border-top:1px solid ${BORD};margin:18px 0`,
};

// Chaque balise d'ouverture reçoit son style (par nom de balise : h1, p, a, td…).
md.core.ruler.push("floppy_styles", (state) => {
  const walk = (tokens: typeof state.tokens) => {
    for (const t of tokens) {
      if (t.nesting === 1 && STYLES[t.tag]) t.attrSet("style", STYLES[t.tag]!);
      if (t.children) walk(t.children);
    }
  };
  walk(state.tokens);
});

// Les titres h4 à h6 et le code en ligne : même style que les voisins.
md.renderer.rules.code_inline = (tokens, i) => `<code style="${STYLES.code}">${md.utils.escapeHtml(tokens[i]!.content)}</code>`;
md.renderer.rules.hr = () => `<hr style="${STYLES.hr}">\n`;
md.renderer.rules.fence = (tokens, i) =>
  `<pre style="background:#f6f8fa;padding:10px 12px;border-radius:4px;overflow:auto;margin:0 0 12px"><code style="font-family:Consolas,Menlo,monospace;font-size:90%">${md.utils.escapeHtml(tokens[i]!.content)}</code></pre>\n`;

/** Page HTML d'un mail : le titre en haut, puis le texte Markdown mis en forme. `lang` : langue de l'assistant (pied de page). */
export function mailHtml(titre: string, markdown: string, lang = "fr"): string {
  const corps = md.render(markdown);
  return `<div style="max-width:680px;margin:0 auto;padding:16px;font-family:${POLICE};font-size:15px;line-height:1.5;color:#1f2328">`
    + `<h1 style="font-size:24px;margin:0 0 16px;line-height:1.3">${md.utils.escapeHtml(titre)}</h1>`
    + corps
    + `<p style="margin:24px 0 0;font-size:12px;color:#8c959f">${lang === "en" ? "Sent by Floppy" : "Envoyé par Floppy"}</p>`
    + `</div>`;
}
