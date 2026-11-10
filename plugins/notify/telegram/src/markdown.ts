// Markdown -> HTML de Telegram (parse_mode "HTML").
// Telegram n'accepte que quelques balises : b, i, u, s, a, code, pre, blockquote. Tout le reste est du texte
// (avec &, < et > échappés). On lit les jetons de markdown-it (sans HTML brut) et on écrit nous-mêmes le résultat.
import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** Limite d'un message Telegram : 4096 caractères. On garde de la marge. */
export const MAX_MESSAGE = 4000;

const md = new MarkdownIt({ html: false, linkify: true });

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** Texte en ligne : gras, italique, barré, code, liens. */
function inline(tokens: Token[] | null): string {
  let out = "";
  // Pour chaque lien ouvert : la balise de fermeture à écrire (vide si le lien est refusé).
  const links: string[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": out += esc(t.content); break;
      case "code_inline": out += `<code>${esc(t.content)}</code>`; break;
      case "softbreak": case "hardbreak": out += "\n"; break;
      case "strong_open": out += "<b>"; break;
      case "strong_close": out += "</b>"; break;
      case "em_open": out += "<i>"; break;
      case "em_close": out += "</i>"; break;
      case "s_open": out += "<s>"; break;
      case "s_close": out += "</s>"; break;
      case "link_open": {
        const href = t.attrGet("href") ?? "";
        if (/^https?:\/\//i.test(href)) { out += `<a href="${escAttr(href)}">`; links.push("</a>"); } else links.push("");
        break;
      }
      case "link_close": out += links.pop() ?? ""; break;
      case "image": out += esc(t.content); break;
      default: if (t.children) out += inline(t.children); else out += esc(t.content);
    }
  }
  return out;
}

/** Lit les blocs à partir de i, jusqu'au jeton `stop` (exclu). Rend les blocs en HTML et la position suivante. */
function blocks(tokens: Token[], start: number, stop?: string): { out: string[]; next: number } {
  const out: string[] = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (stop && t.type === stop) break;
    switch (t.type) {
      case "heading_open": {
        out.push(`<b>${inline(tokens[i + 1]!.children)}</b>`);
        i += 3;
        break;
      }
      case "paragraph_open": {
        out.push(inline(tokens[i + 1]!.children));
        i += 3;
        break;
      }
      case "fence": case "code_block":
        out.push(`<pre>${esc(t.content.replace(/\n$/, ""))}</pre>`);
        i++;
        break;
      case "hr":
        out.push("──────");
        i++;
        break;
      case "blockquote_open": {
        const r = blocks(tokens, i + 1, "blockquote_close");
        out.push(`<blockquote>${r.out.join("\n")}</blockquote>`);
        i = r.next + 1;
        break;
      }
      case "bullet_list_open": case "ordered_list_open": {
        const ordered = t.type === "ordered_list_open";
        let n = Number(t.attrGet("start") ?? 1);
        const closing = ordered ? "ordered_list_close" : "bullet_list_close";
        const lines: string[] = [];
        i++;
        while (i < tokens.length && tokens[i]!.type !== closing) {
          // list_item_open ... list_item_close
          const r = blocks(tokens, i + 1, "list_item_close");
          const body = r.out.join("\n").split("\n");
          const mark = ordered ? `${n}. ` : "• ";
          lines.push(mark + body[0]);
          for (const l of body.slice(1)) lines.push(l ? "  " + l : l);
          n++;
          i = r.next + 1;
        }
        out.push(lines.join("\n"));
        i++;
        break;
      }
      case "table_open": {
        const rows: string[] = [];
        let cells: string[] = [];
        i++;
        while (i < tokens.length && tokens[i]!.type !== "table_close") {
          const c = tokens[i]!;
          if (c.type === "inline") cells.push(inline(c.children));
          else if (c.type === "tr_close") { rows.push(cells.join(" | ")); cells = []; }
          i++;
        }
        out.push(rows.join("\n"));
        i++;
        break;
      }
      case "html_block": out.push(esc(t.content.trim())); i++; break;
      default: i++; // jetons de fermeture ou inconnus : on passe
    }
  }
  return { out, next: i };
}

/** Un bloc HTML par bloc Markdown du haut niveau (paragraphe, liste, code…). */
export function toTelegramBlocks(markdown: string): string[] {
  return blocks(md.parse(markdown, {}), 0).out.filter((b) => b.trim() !== "");
}

/** Markdown -> HTML de Telegram (blocs séparés par une ligne vide). */
export function toTelegramHtml(markdown: string): string {
  return toTelegramBlocks(markdown).join("\n\n");
}

/** Enlève les balises : sert quand une seule ligne dépasse la limite (on la coupe en texte simple). */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Coupe un texte déjà échappé en morceaux ≤ max, sans casser une entité (&amp;). */
function cutPlain(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    const amp = rest.lastIndexOf("&", cut);
    if (amp >= 0 && rest.indexOf(";", amp) >= cut) cut = amp; // on est au milieu d'une entité
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Coupe un bloc trop long, ligne par ligne ; le code et les citations gardent leur balise dans chaque morceau. */
function splitBlock(block: string, max: number): string[] {
  const wrap = /^<(pre|blockquote)>([\s\S]*)<\/\1>$/.exec(block);
  const tag = wrap?.[1];
  const inner = wrap ? wrap[2]! : block;
  const room = tag ? max - (tag.length * 2 + 5) : max;
  const lines = inner.split("\n").flatMap((l) => (l.length > room ? cutPlain(stripTags(l), room) : [l]));
  const parts: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + 1 + l.length > room) { parts.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) parts.push(cur);
  return tag ? parts.map((p) => `<${tag}>${p}</${tag}>`) : parts;
}

/** Titre en gras puis texte, découpés en messages ≤ max caractères, aux limites des blocs. */
export function telegramMessages(title: string, markdown: string, max = MAX_MESSAGE): string[] {
  const all = [...(title.trim() ? [`<b>${esc(title.trim())}</b>`] : []), ...toTelegramBlocks(markdown)];
  const pieces = all.flatMap((b) => (b.length > max ? splitBlock(b, max) : [b]));
  const messages: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > max) { messages.push(cur); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) messages.push(cur);
  return messages;
}
