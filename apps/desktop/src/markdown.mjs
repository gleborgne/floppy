// Markdown -> HTML, dans le processus principal (Node). La fenêtre « Documents » ne reçoit que du HTML déjà nettoyé.
// - Le HTML écrit dans le Markdown est échappé (html: false) : pas de <script>, pas de <img onerror>.
// - Seuls les liens http:, https: et mailto: sont rendus ; « javascript: », « data: », « file: »… restent du texte.
// - Les images : la fenêtre n'a le droit de charger que https et data (voir sa CSP).
import MarkdownIt from "markdown-it";

const OK_LINK = /^(https?|mailto):/i;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
md.validateLink = (url) => OK_LINK.test(String(url).trim());

// Liens : toujours ouverts par l'app (navigateur externe), jamais dans la fenêtre.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options));
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  tokens[i].attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, i, options, env, self);
};

export function renderMarkdown(source) {
  return md.render(String(source ?? "").slice(0, 400_000));
}
