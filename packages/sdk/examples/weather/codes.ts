// Codes météo WMO (Open-Meteo) → mots simples. Un fichier .ts du plugin peut être importé normalement.
export function codeMeteo(code: number): { fr: string; en: string } {
  if (code === 0) return { fr: "ciel dégagé", en: "clear sky" };
  if (code <= 3) return { fr: "quelques nuages", en: "some clouds" };
  if (code <= 48) return { fr: "brouillard", en: "fog" };
  if (code <= 67) return { fr: "pluie", en: "rain" };
  if (code <= 77) return { fr: "neige", en: "snow" };
  if (code <= 82) return { fr: "averses", en: "showers" };
  return { fr: "orage", en: "thunderstorm" };
}
