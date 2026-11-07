// « Ouvre les réglages d'Orca » : retrouve l'élément des réglages à partir du nom entendu (dictée imparfaite tolérée).
import type { ProviderSnapshot, Text } from "@floppy/core";

/** Page à montrer dans la fenêtre des réglages : rubrique, puis page de l'élément. */
export interface SettingsTarget { section: string; provider: string; id: string }
export interface FoundTarget { target: SettingsTarget; label: Text; actions: Text[] }

const compact = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const forms = (t: Text | undefined): string[] => (t === undefined ? [] : typeof t === "string" ? [t] : Object.values(t).filter((x): x is string => !!x));

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length]!;
}

/** 0 = même nom, 1 = nom contenu, 2 = nom proche (fautes de dictée) ; undefined = sans rapport. */
function score(heard: string, label: string): number | undefined {
  const h = compact(heard), l = compact(label);
  if (!h || !l) return undefined;
  if (h === l) return 0;
  if (h.length >= 3 && (l.includes(h) || h.includes(l))) return 1;
  if (Math.min(h.length, l.length) >= 4 && distance(h, l) <= Math.max(1, Math.floor(l.length / 5))) return 2;
  return undefined;
}

/** Meilleur élément pour ce nom. Rubriques « bibliothèque » (modèles à télécharger) ignorées : trop d'homonymes. */
export function findSettingsTarget(providers: ProviderSnapshot[], heard: string): FoundTarget | undefined {
  let best: { s: number; f: FoundTarget } | undefined;
  for (const p of providers) {
    if (p.layout === "library") continue;
    for (const it of p.items) {
      const s = Math.min(...forms(it.label).map((l) => score(heard, l) ?? 9));
      if (s === 9 || (best && best.s <= s)) continue;
      best = { s, f: { target: { section: p.section, provider: p.id, id: it.id }, label: it.label, actions: (it.actions ?? []).map((a) => a.label) } };
    }
  }
  return best?.f;
}
