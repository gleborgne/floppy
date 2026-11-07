// Où poser l'avatar (outil vocal « placer_avatar ») : calcul pur, testé sans Electron.

/**
 * coin : bas_droite, bas_gauche, haut_droite, haut_gauche, centre. ecran : numéro (1 = principal) dans `screens`
 * (zones utiles, dans l'ordre dit par l'utilisateur). active : zone visible de la fenêtre active (cible « fenetre »).
 * Rend la place { x, y } d'un avatar de taille W × H et la phrase { fr, en } à dire ; lève { fr, en } sinon.
 */
export function avatarSpot({ coin = "bas_droite", ecran, cible = "ecran" } = {}, { screens, active, W, H }) {
  let area;
  let where;
  if (cible === "fenetre") {
    if (!active) throw { fr: "fenêtre active introuvable", en: "active window not found" };
    area = active;
    where = { fr: "sur la fenêtre active", en: "on the active window" };
  } else {
    const n = Number.isInteger(ecran) ? ecran : 1;
    if (n < 1 || n > screens.length) throw {
      fr: `il n'y a que ${screens.length} écran${screens.length > 1 ? "s" : ""}`,
      en: `there ${screens.length > 1 ? "are" : "is"} only ${screens.length} screen${screens.length > 1 ? "s" : ""}`,
    };
    area = screens[n - 1];
    where = screens.length > 1 ? { fr: `sur l'écran ${n}`, en: `on screen ${n}` } : { fr: "sur l'écran", en: "on the screen" };
  }
  const m = 12;
  const left = area.x + m, right = area.x + area.width - W - m, top = area.y + m, bottom = area.y + area.height - H - m;
  const pos = {
    bas_droite: [right, bottom], bas_gauche: [left, bottom], haut_droite: [right, top], haut_gauche: [left, top],
    centre: [area.x + (area.width - W) / 2, area.y + (area.height - H) / 2],
  }[coin] ?? [right, bottom];
  const corner = {
    bas_droite: { fr: "bas droite", en: "bottom right" }, bas_gauche: { fr: "bas gauche", en: "bottom left" },
    haut_droite: { fr: "haut droite", en: "top right" }, haut_gauche: { fr: "haut gauche", en: "top left" },
    centre: { fr: "centre", en: "center" },
  }[coin] ?? { fr: coin.replace("_", " "), en: coin.replace("_", " ") };
  return {
    x: Math.round(pos[0]), y: Math.round(pos[1]),
    // Phrase reprise par Floppy : la page de l'avatar choisit la langue de l'assistant.
    text: { fr: `Avatar placé ${corner.fr} ${where.fr}.`, en: `Avatar moved to ${corner.en} ${where.en}.` },
  };
}
