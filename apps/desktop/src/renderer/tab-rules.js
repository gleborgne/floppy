// Règles des onglets de la fenêtre des réglages (fonctions pures, testées sans fenêtre).

/** Un groupe de 1 ou 2 réglages est léger : il reste sur la page au lieu d'avoir son propre onglet. */
export const LIGHT_MAX = 2;
export const isLight = (settingsList) => settingsList.length <= LIGHT_MAX;
