// Calcul d'expressions arithmétiques : analyseur à descente récursive écrit à la main (jamais eval ni Function).
//
// Grammaire (priorité croissante) :
//   somme      := produit (('+' | '-') produit)*
//   produit    := unaire (('*' | '/' | '%' | 'de' | 'of') unaire)*      « % » suivi d'un opérande = modulo
//   unaire     := '-' unaire | '+' unaire | puissance
//   puissance  := postfixe (('^' | '**') unaire)?                       associative à droite : 2^3^2 = 2^9 ; -2^2 = -4
//   postfixe   := primaire '%'*                                         « 15% » = 0,15 (« % » non suivi d'un opérande)
//   primaire   := nombre | constante | fonction '(' args ')' | '(' somme ')'
// Nombres décimaux avec point ou virgule. Dans les parenthèses d'une fonction, la virgule sépare les arguments
// (« max(2,5) ») ; le point-virgule les sépare aussi, partout.

export class CalcError extends Error {
  readonly fr: string;
  readonly en: string;
  constructor(fr: string, en: string) { super(fr); this.fr = fr; this.en = en; }
}

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: "+" | "-" | "*" | "/" | "%" | "^" | "(" | ")" | "," };

const MAX_LEN = 500;
const MAX_DEPTH = 40;
const OF_WORDS = ["de", "of"];

const FUNCTIONS: Record<string, { min: number; max: number; run: (a: number[]) => number }> = {
  sqrt: { min: 1, max: 1, run: ([x]) => Math.sqrt(x!) },
  abs: { min: 1, max: 1, run: ([x]) => Math.abs(x!) },
  floor: { min: 1, max: 1, run: ([x]) => Math.floor(x!) },
  ceil: { min: 1, max: 1, run: ([x]) => Math.ceil(x!) },
  round: { min: 1, max: 2, run: ([x, d = 0]) => roundTo(x!, d) },
  min: { min: 1, max: 50, run: (a) => Math.min(...a) },
  max: { min: 1, max: 50, run: (a) => Math.max(...a) },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const ALIASES: Record<string, string> = { racine: "sqrt", arrondi: "round", plafond: "ceil", plancher: "floor", π: "pi" };

function roundTo(x: number, digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) throw new CalcError("round : le nombre de décimales doit être un entier de 0 à 12.", "round: the number of decimals must be an integer from 0 to 12.");
  const f = 10 ** digits;
  // petit décalage relatif : 1.005 → 1.01 comme à la main
  return Math.sign(x) * Math.round(Math.abs(x) * f * (1 + Number.EPSILON)) / f;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  /** Pile des parenthèses ouvertes : true = parenthèse d'une fonction (la virgule y sépare les arguments). */
  const stack: boolean[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const commaIsDecimal = !stack.at(-1);
    if (isDigit(c) || ((c === "." || (c === "," && commaIsDecimal)) && isDigit(src[i + 1]))) {
      let j = i;
      let seenDot = false;
      for (; j < src.length; j++) {
        const d = src[j]!;
        if (isDigit(d)) continue;
        if ((d === "." || (d === "," && commaIsDecimal)) && isDigit(src[j + 1])) {
          if (seenDot) throw new CalcError(`Nombre invalide près de « ${src.slice(i, j + 2)} ».`, `Invalid number near “${src.slice(i, j + 2)}”.`);
          seenDot = true; continue;
        }
        break;
      }
      out.push({ k: "num", v: Number(src.slice(i, j).replace(",", ".")) });
      i = j; continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i;
      while (j < src.length && /[\p{L}\p{N}_]/u.test(src[j]!)) j++;
      out.push({ k: "id", v: src.slice(i, j).toLowerCase() });
      i = j; continue;
    }
    if (c === "*" && src[i + 1] === "*") { out.push({ k: "op", v: "^" }); i += 2; continue; }
    if (c === "×" || c === "·") { out.push({ k: "op", v: "*" }); i++; continue; }
    if (c === "÷") { out.push({ k: "op", v: "/" }); i++; continue; }
    if (c === "−" || c === "–") { out.push({ k: "op", v: "-" }); i++; continue; }
    if (c === ";") { out.push({ k: "op", v: "," }); i++; continue; }
    if ("+-*/%^(),".includes(c)) {
      if (c === "(") { const prev = out.at(-1); stack.push(prev?.k === "id" && !OF_WORDS.includes(prev.v)); }
      if (c === ")") stack.pop();
      out.push({ k: "op", v: c as "+" }); i++; continue;
    }
    throw new CalcError(`Caractère non pris en charge : « ${c} ».`, `Unsupported character: “${c}”.`);
  }
  return out;
}

class Parser {
  private p = 0;
  private depth = 0;
  private readonly t: Tok[];
  constructor(t: Tok[]) { this.t = t; }

  private peek(): Tok | undefined { return this.t[this.p]; }
  private isOp(v: string): boolean { const x = this.t[this.p]; return x?.k === "op" && x.v === v; }

  parse(): number {
    if (!this.t.length) throw new CalcError("Expression vide.", "Empty expression.");
    const v = this.sum();
    const rest = this.peek();
    if (rest) throw new CalcError(`Expression invalide près de « ${show(rest)} ».`, `Invalid expression near “${show(rest)}”.`);
    return v;
  }

  private sum(): number {
    let v = this.product();
    for (;;) {
      if (this.isOp("+")) { this.p++; v += this.product(); }
      else if (this.isOp("-")) { this.p++; v -= this.product(); }
      else return v;
    }
  }

  /** Un « % » est un modulo seulement si un opérande le suit ; sinon c'est un pourcentage (traité dans postfix). */
  private startsOperand(at: number): boolean {
    const x = this.t[at];
    if (!x) return false;
    return x.k === "num" || (x.k === "id" && !OF_WORDS.includes(x.v)) || (x.k === "op" && (x.v === "(" || x.v === "-" || x.v === "+"));
  }

  private product(): number {
    let v = this.unary();
    for (;;) {
      const x = this.peek();
      if (!x) return v;
      if (x.k === "id" && OF_WORDS.includes(x.v)) { this.p++; v *= this.unary(); }
      else if (x.k !== "op") return v;
      else if (x.v === "*") { this.p++; v *= this.unary(); }
      else if (x.v === "/") {
        this.p++;
        const d = this.unary();
        if (d === 0) throw new CalcError("Division par zéro.", "Division by zero.");
        v /= d;
      } else if (x.v === "%" && this.startsOperand(this.p + 1)) {
        this.p++;
        const d = this.unary();
        if (d === 0) throw new CalcError("Modulo par zéro.", "Modulo by zero.");
        v %= d;
      } else return v;
    }
  }

  private unary(): number {
    if (++this.depth > MAX_DEPTH) throw new CalcError("Expression trop imbriquée.", "Expression nested too deeply.");
    try {
      if (this.isOp("-")) { this.p++; return -this.unary(); }
      if (this.isOp("+")) { this.p++; return this.unary(); }
      const base = this.postfix();
      if (this.isOp("^")) { this.p++; return base ** this.unary(); }
      return base;
    } finally { this.depth--; }
  }

  private postfix(): number {
    let v = this.primary();
    while (this.isOp("%") && !this.startsOperand(this.p + 1)) { this.p++; v /= 100; }
    return v;
  }

  private primary(): number {
    const x = this.peek();
    if (!x) throw new CalcError("Expression incomplète.", "Incomplete expression.");
    this.p++;
    if (x.k === "num") return x.v;
    if (x.k === "id") {
      const name = ALIASES[x.v] ?? x.v;
      if (this.isOp("(")) {
        const f = FUNCTIONS[name];
        if (!f) throw new CalcError(`Fonction inconnue : « ${x.v} ».`, `Unknown function: “${x.v}”.`);
        this.p++;
        const args: number[] = [];
        if (this.isOp(")")) this.p++;
        else {
          for (;;) {
            args.push(this.sum());
            if (this.isOp(",")) { this.p++; continue; }
            if (this.isOp(")")) { this.p++; break; }
            throw new CalcError(`Parenthèse fermante attendue après un argument de ${x.v}.`, `Closing parenthesis expected after an argument of ${x.v}.`);
          }
        }
        if (args.length < f.min || args.length > f.max) {
          const n = f.min === f.max ? String(f.min) : `${f.min}-${f.max}`;
          throw new CalcError(`${x.v} attend ${n} argument(s).`, `${x.v} takes ${n} argument(s).`);
        }
        if (name === "sqrt" && args[0]! < 0) throw new CalcError("Racine carrée d'un nombre négatif.", "Square root of a negative number.");
        return f.run(args);
      }
      if (name in CONSTANTS) return CONSTANTS[name]!;
      throw new CalcError(`Mot inconnu : « ${x.v} ».`, `Unknown word: “${x.v}”.`);
    }
    if (x.v === "(") {
      const v = this.sum();
      if (!this.isOp(")")) throw new CalcError("Parenthèse fermante manquante.", "Missing closing parenthesis.");
      this.p++;
      return v;
    }
    throw new CalcError(`Expression invalide près de « ${x.v} ».`, `Invalid expression near “${x.v}”.`);
  }
}

function show(t: Tok): string { return t.k === "num" ? String(t.v) : t.v; }

/** Arrondit à 12 chiffres significatifs : 0.1 + 0.2 → 0.3. */
export function tidy(x: number): number { return Number(x.toPrecision(12)); }

export function evaluate(expression: string): number {
  const src = expression.trim();
  if (src.length > MAX_LEN) throw new CalcError("Expression trop longue.", "Expression too long.");
  const v = new Parser(lex(src)).parse();
  if (!Number.isFinite(v)) throw new CalcError("Le résultat n'est pas un nombre fini (trop grand ou indéfini).", "The result is not a finite number (too large or undefined).");
  return tidy(v) + 0; // + 0 : -0 devient 0
}

/** Écriture sans exposant tant que c'est lisible ; virgule décimale en français. */
export function formatNumber(x: number, lang: "fr" | "en"): string {
  const s = Number.isInteger(x) && Math.abs(x) < 1e21 ? BigInt(x).toString() : Math.abs(x) >= 1e-6 && Math.abs(x) < 1e21 ? String(x) : x.toExponential();
  return lang === "fr" ? s.replace(".", ",") : s;
}
