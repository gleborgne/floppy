// Forme parlée d'une phrase : le texte tel que la voix doit le lire (heures, adresses, chemins, symboles).
// Fonction pure ; le texte montré à l'écran ne passe jamais par ici. Le texte ordinaire reste strictement identique.

type Lang = "fr" | "en";

const tr = (lang: Lang, fr: string, en: string): string => (lang === "fr" ? fr : en);

const NUMBER = String.raw`\d+(?:[   ]\d{3})*(?:[.,]\d+)?`;

/** Ponctuation de phrase collée à la fin d'une adresse : elle ne fait pas partie de l'adresse. */
const URL_RE = /https?:\/\/[^\s<>"«»]*[^\s<>"«».,;:!?)\]'’]/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Identifiant hexadécimal long (empreinte, jeton) : au moins un chiffre et une lettre a-f, pour ne pas toucher un mot ou un grand nombre. */
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi;
const WIN_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'<>|*?]*[^\s"'<>|*?.,;:!)]/g;
/** Chemin POSIX d'au moins deux séparateurs, en début de mot (« 10/11/2026 » et « et/ou » n'en sont pas). */
const POSIX_PATH_RE = /(?<![\w./\\:~-])(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g;
const TIME_RE = /(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(?:\s?([AaPp])\.?[Mm]\.?(?![\w]))?/g;

function pathName(p: string): { name: string; file: boolean } {
  const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return { name, file: /\.\w{1,8}$/.test(name) };
}

function pathSpoken(p: string, lang: Lang): string {
  const { name, file } = pathName(p);
  if (!name) return tr(lang, "un dossier", "a folder");
  return file ? `${tr(lang, "un fichier", "a file")} ${name}` : `${tr(lang, "un dossier", "a folder")} ${name}`;
}

function timeSpoken(hh: string, mm: string, meridiem: string | undefined, lang: Lang): string {
  let h = Number(hh);
  if (meridiem) { // 12 h avec AM / PM
    const pm = meridiem.toLowerCase() === "p";
    h =(h % 12) + (pm ? 12 : 0);
  }
  if (lang === "fr") return mm === "00" ? `${h} h` : `${h} h ${mm}`;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === "00" ? `${h12} ${suffix}` : `${h12}:${mm} ${suffix}`;
}

/** Prépare un texte pour la synthèse vocale dans la langue donnée. */
export function spokenForm(text: string, lang: "fr" | "en"): string {
  let s = text;
  s = s.replace(URL_RE, (u) => {
    let host = "";
    try { host = new URL(u).hostname.replace(/^www\./i, ""); } catch { /* adresse illisible : « un lien » seul */ }
    return host ? `${tr(lang, "un lien vers", "a link to")} ${host}` : tr(lang, "un lien", "a link");
  });
  s = s.replace(UUID_RE, tr(lang, "un identifiant", "an identifier"));
  s = s.replace(HEX_RE, tr(lang, "un identifiant", "an identifier"));
  s = s.replace(WIN_PATH_RE, (p) => pathSpoken(p, lang));
  s = s.replace(POSIX_PATH_RE, (p) => pathSpoken(p, lang));
  s = s.replace(TIME_RE, (all, hh: string, mm: string, mer: string | undefined) => {
    if (mer && (Number(hh) < 1 || Number(hh) > 12)) return all;
    return timeSpoken(hh, mm, mer, lang);
  });
  // Montants : « 5 € », « 1,5 € », « €5 ».
  const euros = (n: string) => `${n} ${n === "1" ? "euro" : "euros"}`;
  s = s.replace(new RegExp(`(${NUMBER})\\s?€`, "g"), (_a, n: string) => euros(n));
  s = s.replace(new RegExp(`€\\s?(${NUMBER})`, "g"), (_a, n: string) => euros(n));
  s = s.replace(/\s*%/g, ` ${tr(lang, "pour cent", "percent")}`).replace(/^ (pour cent|percent)/, "$1");
  s = s.replace(/(?<=\s)&(?=\s)/g, tr(lang, "et", "and"));
  s = s.replace(/\s*(?:→|->)\s*/g, ` ${tr(lang, "vers", "to")} `).replace(/^ (vers|to) /, "$1 ");
  return s;
}
