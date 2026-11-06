// Dictée : transforme les transcriptions successives en frappes clavier sûres.
// - Le service voix découpe la dictée en segments (pauses) et envoie, pour chaque segment,
//   des hypothèses partielles (l'audio du segment retranscrit toutes les ~0,6 s) puis une version finale.
// - Un mot n'est tapé que s'il est identique dans deux hypothèses de suite (mot « confirmé ») :
//   il apparaît avec un peu de retard, mais il ne change presque jamais.
// - La version finale du segment corrige ce qui diffère (effacer `del` caractères, puis taper `ins`).

/** Une frappe : effacer `del` caractères (Retour arrière), puis taper `ins`. */
export interface DictationEdit { del: number; ins: string }

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

export class Dictation {
  /** Faux après l'arrêt : les versions finales en cours sont encore tapées, plus rien de nouveau n'est écouté. */
  active = true;
  /** Texte déjà tapé pour le segment en cours (sans le séparateur). */
  private typed = "";
  private seg = -1;
  /** Hypothèse précédente du segment en cours (en mots). */
  private prev: string[] = [];
  /** Nombre de mots confirmés (donc tapés) dans le segment en cours. */
  private committed = 0;
  /** Segments déjà terminés : leurs hypothèses en retard sont ignorées. */
  private lastFinal = -1;
  /** Quelque chose a déjà été tapé dans cette dictée : le segment suivant commence par une espace. */
  private any = false;
  private sep = "";

  /** Hypothèse partielle d'un segment. Renvoie les mots nouvellement confirmés à taper (ou rien). */
  partial(seg: number, text: string): DictationEdit | undefined {
    if (seg <= this.lastFinal) return undefined;
    if (seg !== this.seg) this.open(seg);
    const cur = words(text);
    // Les mots déjà tapés doivent rester en tête de l'hypothèse ; sinon on attend la version finale.
    const done = words(this.typed);
    const sameHead = done.every((w, i) => cur[i] === w);
    let agree = this.committed;
    // Le dernier mot reste en attente : il est souvent coupé ou reçoit encore sa ponctuation.
    if (sameHead) while (agree < cur.length - 1 && agree < this.prev.length && cur[agree] === this.prev[agree]) agree++;
    this.prev = cur;
    if (agree <= this.committed) return undefined;
    const add = cur.slice(this.committed, agree);
    this.committed = agree;
    return this.append((this.typed ? " " : "") + add.join(" "));
  }

  /** Version finale d'un segment : corrige ce qui a été tapé pour qu'il corresponde au texte final. */
  final(seg: number, text: string): DictationEdit | undefined {
    if (seg <= this.lastFinal) return undefined;
    if (seg !== this.seg) this.open(seg);
    this.lastFinal = seg;
    const target = words(text).join(" ");
    const have = this.typed;
    this.prev = []; this.committed = 0;
    if (!have && !target) return undefined;
    let common = 0;
    while (common < have.length && common < target.length && have[common] === target[common]) common++;
    const edit: DictationEdit = { del: have.length - common, ins: target.slice(common) };
    if (!have) { edit.ins = this.sep + target; this.any = true; }
    else if (!target) edit.del += this.sep.length; // segment vide au final : on retire aussi l'espace ajoutée
    this.typed = target;
    return edit.del || edit.ins ? edit : undefined;
  }

  private open(seg: number) {
    this.seg = seg;
    this.typed = "";
    this.prev = [];
    this.committed = 0;
    this.sep = this.any ? " " : "";
  }

  private append(s: string): DictationEdit {
    let ins = s;
    if (!this.typed) { ins = this.sep + s; this.any = true; }
    this.typed += s;
    return { del: 0, ins };
  }
}
