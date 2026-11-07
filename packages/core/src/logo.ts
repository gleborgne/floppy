// Logos des éléments (connecteurs, applications) : la vraie marque de l'outil, montrée au début de sa ligne.
//
// Trois formes :
// - une image prête (adresse data:image/…) : un SVG livré avec le plugin (svgLogo), l'icône envoyée par un serveur MCP ;
// - { program } : l'icône d'un programme de la machine (chemin du .exe, de l'app) ;
// - { handler } : l'icône du programme qui ouvre un protocole (« https » = le navigateur par défaut).
// Les deux dernières sont lues par l'app (le noyau ne touche pas aux icônes du système) ; la CLI les ignore.

/** Logo d'un élément (voir en tête du fichier). */
export type Logo = string | { program: string } | { handler: string };

/** Taille maximale d'une image de logo (adresse data: comprise). */
export const LOGO_MAX = 256 * 1024;

const IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)(;[a-z0-9=.+-]+)*(;base64)?,/i;

/** Une adresse data:image/… raisonnable (type d'image connu, taille bornée) ; sinon undefined. */
export function imageLogo(src: unknown): string | undefined {
  return typeof src === "string" && src.length <= LOGO_MAX && IMAGE.test(src) ? src : undefined;
}

/** Un SVG (texte) → adresse data:image/svg+xml. */
export function svgLogo(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg.trim(), "utf8").toString("base64")}`;
}

/**
 * Un pictogramme d'une seule couleur (chemin SVG sur une grille 24×24, ex. Simple Icons) → logo à sa couleur de marque.
 * `hex` : « 7C3AED » ou « #7C3AED ».
 */
export function glyphLogo(path: string, hex: string): string {
  const fill = `#${hex.replace(/^#/, "")}`;
  return svgLogo(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="${path}"/></svg>`);
}

/** Un logo valide pour la fenêtre (image bornée, ou programme / protocole à lire par l'app) ; sinon undefined. */
export function cleanLogo(v: unknown): Logo | undefined {
  if (typeof v === "string") return imageLogo(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.program === "string" && o.program.trim()) return { program: o.program.trim() };
    if (typeof o.handler === "string" && /^[a-z][a-z0-9+.-]*$/i.test(o.handler)) return { handler: o.handler.toLowerCase() };
  }
  return undefined;
}
