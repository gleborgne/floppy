// Où poser l'avatar (outil vocal « placer_avatar ») : calcul pur, testé sans Electron.

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
