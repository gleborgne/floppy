// Règles des formulaires et de la chaîne d'étapes de la fenêtre des réglages (fonctions pures, testées sans fenêtre).

/**
 * Ajoute à une liste (champ « list », montré en pastilles) le texte tapé ou collé : un élément par ligne ou par virgule,
 * espaces retirés, sans doublon (comparé sans tenir compte des majuscules). Rend une nouvelle liste.
 */
export function listAdd(list: string[] | null | undefined, text: unknown): string[] {
  const out = [...(list ?? [])];
  const seen = new Set(out.map((x) => String(x).toLowerCase()));
  for (const raw of String(text ?? "").split(/[\n,;]/)) {
    const x = raw.trim();
    if (!x || seen.has(x.toLowerCase())) continue;
    seen.add(x.toLowerCase());
    out.push(x);
  }
  return out;
}

/** Champs obligatoires vides (parmi ceux visibles). */
export function missingFields<F extends { key: string; required?: boolean }>(
  fields: F[], values: Record<string, unknown>, visible: (f: F, values: Record<string, unknown>) => boolean = () => true,
): F[] {
  return fields.filter((f) => f.required && visible(f, values) && (() => {
    const v = values[f.key];
    return v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
  })());
}

/**
 * Chaîne d'étapes d'une rubrique : ses slots dans l'ordre de leur `step`, s'il y en a au moins deux et qu'ils en ont
 * tous un (ex. Écoute : détecteur de parole → transcription → mot d'activation). Sinon null : onglets ordinaires.
 */
export function chainOf<S extends { step?: number }>(slots: S[] | null | undefined): S[] | null {
  if (!slots || slots.length < 2 || slots.some((s) => !Number.isInteger(s.step))) return null;
  return [...slots].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
}

/**
 * Après « Ajouter » dans la fenêtre d'ajout. Réussi : la fenêtre se ferme et un toast le dit (pas de 2e fenêtre
 * à fermer). Raté : l'erreur sous le formulaire, valeurs gardées ; si la fenêtre est déjà fermée, un toast d'erreur.
 */
export function addOutcome(
  r: { ok?: boolean; text?: string } | null | undefined, editorOpen: boolean, fallback = { done: "OK", refused: "Refusé" },
): { close: boolean; toast?: { text: string; bad: boolean }; error?: string } {
  const text = r?.text || (r?.ok ? fallback.done : fallback.refused);
  if (r?.ok) return { close: editorOpen, toast: { text, bad: false } };
  return editorOpen ? { close: false, error: text } : { close: false, toast: { text, bad: true } };
}

/**
 * Valeur gardée d'une liste de choix qui n'est plus proposée (ex. un modèle qui ne fait plus l'affaire) : son nom
 * court (fin d'un chemin), pour la montrer marquée plutôt qu'une liste vide. undefined : rien à montrer.
 */
export function goneOption(options: { value: unknown }[] | undefined, v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if ((options ?? []).some((o) => String(o.value) === String(v))) return undefined;
  return String(v).split(/[\\/]/).pop();
}
