// Où poser l'avatar (outil vocal « place_avatar ») : calcul pur, testé sans Electron.

export type Area = { x: number; y: number; width: number; height: number };
/** Texte dans les deux langues (le noyau choisit celle qu'il dit). */
export type Bilingual = { fr: string; en: string };
export interface SpotOptions { corner?: string; screen?: number; target?: string }
export interface SpotContext { screens: Area[]; active: Area | null; W: number; H: number }

/**
 * corner : bottom_right, bottom_left, top_right, top_left, center. screen : numéro (1 = principal) dans `screens`
 * (zones utiles, dans l'ordre dit par l'utilisateur). active : zone visible de la fenêtre active (target « window »).
 * Rend la place { x, y } d'un avatar de taille W × H et la phrase { fr, en } à dire ; lève { fr, en } sinon.
 */
export function avatarSpot({ corner = "bottom_right", screen, target = "screen" }: SpotOptions = {}, { screens, active, W, H }: SpotContext): { x: number; y: number; text: Bilingual } {
  let area: Area;
  let where: Bilingual;
  if (target === "window") {
    if (!active) throw { fr: "fenêtre active introuvable", en: "active window not found" };
    area = active;
    where = { fr: "sur la fenêtre active", en: "on the active window" };
  } else {
    const n = typeof screen === "number" && Number.isInteger(screen) ? screen : 1;
    if (n < 1 || n > screens.length) throw {
      fr: `il n'y a que ${screens.length} écran${screens.length > 1 ? "s" : ""}`,
      en: `there ${screens.length > 1 ? "are" : "is"} only ${screens.length} screen${screens.length > 1 ? "s" : ""}`,
    };
    area = screens[n - 1]!;
    where = screens.length > 1 ? { fr: `sur l'écran ${n}`, en: `on screen ${n}` } : { fr: "sur l'écran", en: "on the screen" };
  }
  const m = 12;
  const left = area.x + m, right = area.x + area.width - W - m, top = area.y + m, bottom = area.y + area.height - H - m;
  const pos: Record<string, [number, number]> = {
    bottom_right: [right, bottom], bottom_left: [left, bottom], top_right: [right, top], top_left: [left, top],
    center: [area.x + (area.width - W) / 2, area.y + (area.height - H) / 2],
  };
  const [px, py] = pos[corner] ?? [right, bottom];
  const corners: Record<string, Bilingual> = {
    bottom_right: { fr: "bas droite", en: "bottom right" }, bottom_left: { fr: "bas gauche", en: "bottom left" },
    top_right: { fr: "haut droite", en: "top right" }, top_left: { fr: "haut gauche", en: "top left" },
    center: { fr: "centre", en: "center" },
  };
  const label = corners[corner] ?? { fr: corner.replace("_", " "), en: corner.replace("_", " ") };
  return {
    x: Math.round(px), y: Math.round(py),
    // Phrase reprise par Floppy : la page de l'avatar choisit la langue de l'assistant.
    text: { fr: `Avatar placé ${label.fr} ${where.fr}.`, en: `Avatar moved to ${label.en} ${where.en}.` },
  };
}

/** Ce que la page de l'avatar envoie (IPC `avatar:place`, champs `corner`, `screen`, `target`) → options sûres pour `avatarSpot`. */
export function placeOptions(a: unknown): SpotOptions {
  const p = (a && typeof a === "object" ? a : {}) as { corner?: unknown; screen?: unknown; target?: unknown };
  return {
    corner: String(p.corner || "bottom_right"),
    ...(p.screen === undefined ? {} : { screen: Number(p.screen) }),
    target: p.target === "window" ? "window" : "screen",
  };
}

export interface ChatSpotContext {
  /** Fenêtre de l'avatar (position et taille) et zone utile de son écran. */
  avatar: Area;
  work: Area;
  /** Hauteur de la tête, en bas de la fenêtre de l'avatar. */
  head: number;
  /** Taille voulue de la conversation et hauteur en dessous de laquelle on ne la réduit plus. */
  size: { width: number; height: number; minHeight: number };
}

/**
 * Où poser la fenêtre « Conversation » : juste au-dessus de la tête (bord bas = haut de la tête − 8 px, bords droits alignés),
 * réduite jusqu'à sa hauteur minimale si la place manque ; sinon sous l'avatar ; sinon à côté (à gauche, puis à droite).
 * Toujours dans la zone utile de l'écran.
 */
export function chatSpot({ avatar, work, head, size }: ChatSpotContext): Area {
  const gap = 8;
  const width = Math.min(size.width, work.width);
  const clampX = (x: number) => Math.min(Math.max(x, work.x), work.x + work.width - width);
  const fit = (height: number, y: number, x: number): Area => {
    const h = Math.min(height, work.height);
    return { x: Math.round(clampX(x)), y: Math.round(Math.min(Math.max(y, work.y), work.y + work.height - h)), width, height: Math.round(h) };
  };
  const aligned = avatar.x + avatar.width - width;
  // Au-dessus de la tête.
  const bottom = avatar.y + avatar.height - head - gap;
  const above = bottom - work.y;
  if (above >= size.minHeight) { const h = Math.min(size.height, above); return fit(h, bottom - h, aligned); }
  // Sous l'avatar.
  const top = avatar.y + avatar.height + gap;
  const below = work.y + work.height - top;
  if (below >= size.minHeight) return fit(Math.min(size.height, below), top, aligned);
  // À côté : le bas aligné sur celui de l'avatar, à gauche si cela tient, sinon à droite.
  const h = Math.min(size.height, work.height);
  const y = avatar.y + avatar.height - h;
  const left = avatar.x - gap - width;
  if (left >= work.x) return fit(h, y, left);
  return fit(h, y, avatar.x + avatar.width + gap);
}
