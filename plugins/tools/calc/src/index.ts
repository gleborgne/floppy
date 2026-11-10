// Plugin `calc` : calculs locaux, sans réseau, pour ne pas confier un calcul au grand modèle (qui se trompe).
//
// - `calculate(expression)` : arithmétique (+ - * / % ^, parenthèses, pourcentages, sqrt, round, floor, ceil, min, max, abs).
//   Analyseur écrit à la main (expr.ts) : aucun eval.
// - `date_math(op, …)` : différence entre deux dates, date + durée, jour de la semaine, jours ouvrés (dates.ts).
// Les deux sont de niveau read : rien n'est lu ni écrit hors du calcul.
import { z } from "zod";
import { definePlugin, T, type Text } from "@floppy/core";
import { evaluate, formatNumber, CalcError } from "./expr.ts";
import {
  DateError, UNITS, WEEKDAYS_FR, WEEKDAYS_EN, parseWhen, iso, calendarDays, addDuration, workdaysBetween, type Unit, type Parsed,
} from "./dates.ts";

export const Config = z.object({});

const OPS = ["diff", "add", "weekday", "workdays"] as const;
type Op = (typeof OPS)[number];

const UNIT_FR: Record<Unit, [string, string]> = {
  minutes: ["minute", "minutes"], hours: ["heure", "heures"], days: ["jour", "jours"],
  weeks: ["semaine", "semaines"], months: ["mois", "mois"], years: ["an", "ans"],
};
const unitFr = (u: Unit, n: number): string => UNIT_FR[u][Math.abs(n) === 1 ? 0 : 1];
const unitEn = (u: Unit, n: number): string => (Math.abs(n) === 1 ? u.slice(0, -1) : u);

const fail = (text: Text) => ({ status: "failed" as const, text });
const wd = (d: Date): { fr: string; en: string } => T(WEEKDAYS_FR[d.getDay()]!, WEEKDAYS_EN[d.getDay()]!);
const when = (p: Parsed): string => iso(p.date, p.hasTime);

export function dateMath(a: Record<string, unknown>, now: Date): { status: "done" | "failed"; text: Text } {
  try {
    const op = String(a.op ?? "") as Op;
    if (!OPS.includes(op)) return fail(T(`Opération inconnue « ${String(a.op ?? "").slice(0, 30)} » : choisis ${OPS.join(", ")}.`, `Unknown operation “${String(a.op ?? "").slice(0, 30)}”: choose ${OPS.join(", ")}.`));
    const hasFrom = String(a.from ?? "").trim() !== "";

    if (op === "weekday") {
      const p = parseWhen(hasFrom ? a.from : "today", now, "from");
      const w = wd(p.date);
      return { status: "done", text: T(`Le ${when(p)} est un ${w.fr}.`, `${when(p)} is a ${w.en}.`) };
    }

    if (op === "add") {
      const unit = String(a.unit ?? "days") as Unit;
      if (!UNITS.includes(unit)) return fail(T(`Unité inconnue « ${String(a.unit).slice(0, 20)} » : choisis ${UNITS.join(", ")}.`, `Unknown unit “${String(a.unit).slice(0, 20)}”: choose ${UNITS.join(", ")}.`));
      const amount = Number(a.amount);
      if (a.amount === undefined || a.amount === null || a.amount === "" || !Number.isInteger(amount) || Math.abs(amount) > 100_000) {
        return fail(T("amount doit être un nombre entier (négatif pour le passé : « il y a 3 semaines » = -3).", "amount must be a whole number (negative for the past: “3 weeks ago” = -3)."));
      }
      const timeUnit = unit === "minutes" || unit === "hours";
      const start = parseWhen(hasFrom ? a.from : timeUnit ? "now" : "today", now, "from");
      const end = addDuration(start.date, amount, unit);
      if (Number.isNaN(end.getTime())) return fail(T("Date hors limites.", "Date out of range."));
      const withTime = start.hasTime || timeUnit;
      const w = wd(end);
      return {
        status: "done",
        text: T(
          `${when(start)} ${amount < 0 ? "-" : "+"} ${Math.abs(amount)} ${unitFr(unit, amount)} = ${iso(end, withTime)} (${w.fr}).`,
          `${when(start)} ${amount < 0 ? "-" : "+"} ${Math.abs(amount)} ${unitEn(unit, amount)} = ${iso(end, withTime)} (${w.en}).`,
        ),
      };
    }

    // diff et workdays : deux dates
    const from = parseWhen(a.from, now, "from");
    const to = parseWhen(a.to, now, "to");
    if (op === "workdays") {
      const n = workdaysBetween(from.date, to.date);
      return {
        status: "done",
        text: T(
          `Du ${when(from)} au ${when(to)} : ${n} jour(s) ouvré(s) (lundi au vendredi, deux dates comprises, jours fériés non déduits).`,
          `From ${when(from)} to ${when(to)}: ${n} working day(s) (Monday to Friday, both dates included, public holidays not deducted).`,
        ),
      };
    }
    if (!from.hasTime && !to.hasTime) {
      const d = calendarDays(from.date, to.date);
      const ad = Math.abs(d);
      const weeks = Math.floor(ad / 7);
      const rest = ad % 7;
      const sign = d < 0 ? -1 : 1;
      return {
        status: "done",
        text: T(
          `Du ${when(from)} au ${when(to)} : ${d} jour(s)${ad >= 7 ? ` (${sign * weeks} semaine(s) et ${rest} jour(s))` : ""}${d < 0 ? ", la seconde date est avant la première" : ""}.`,
          `From ${when(from)} to ${when(to)}: ${d} day(s)${ad >= 7 ? ` (${sign * weeks} week(s) and ${rest} day(s))` : ""}${d < 0 ? ", the second date is before the first" : ""}.`,
        ),
      };
    }
    const minutes = Math.round((to.date.getTime() - from.date.getTime()) / 60_000);
    const am = Math.abs(minutes);
    const days = Math.floor(am / 1440);
    const hours = Math.floor((am % 1440) / 60);
    const mins = am % 60;
    const s = minutes < 0 ? "-" : "";
    const hoursTotal = formatNumber(Math.round((minutes / 60) * 100) / 100, "fr");
    return {
      status: "done",
      text: T(
        `Du ${when(from)} au ${when(to)} : ${s}${days} jour(s) ${hours} h ${mins} min (soit ${hoursTotal} heures, ${minutes} minutes)${minutes < 0 ? ", la seconde date est avant la première" : ""}.`,
        `From ${when(from)} to ${when(to)}: ${s}${days} day(s) ${hours} h ${mins} min (${hoursTotal.replace(",", ".")} hours, ${minutes} minutes)${minutes < 0 ? ", the second date is before the first" : ""}.`,
      ),
    };
  } catch (e) {
    if (e instanceof DateError) return fail(T(e.fr, e.en));
    throw e;
  }
}

/** `now` : horloge injectable pour les tests. */
export function createCalcPlugin(now: () => Date = () => new Date()) {
  return definePlugin<z.infer<typeof Config>>({
    manifest: {
      id: "calc",
      version: "0.1.0",
      licence: "MIT",
      description: "Calculs locaux : arithmétique et dates.",
    },
    config: Config,
    apply(ctx) {
      ctx.tools.register([
        {
          name: "calculate",
          description: "Calcule une expression arithmétique, sans réseau. Utilise-le pour TOUT calcul, même en plusieurs étapes (total, moyenne, remise, TVA, conversion, partage d'addition) : n'invente jamais le résultat de tête. Opérateurs + - * / % (modulo) ^ (puissance), parenthèses, nombres décimaux avec point ou virgule, pourcentages (« 15% de 240 » s'écrit 15% de 240 ou 0.15*240), fonctions sqrt, round(x) ou round(x; décimales), floor, ceil, min, max, abs, constantes pi et e. Sépare les arguments d'une fonction par un point-virgule. Rend le résultat arrondi proprement ; répète-le tel quel à l'utilisateur.",
          inputSchema: { type: "object", properties: { expression: { type: "string", description: "L'expression à calculer, par exemple (1200 + 350) * 1.2 ou 15% de 240." } }, required: ["expression"] },
          level: "read",
          handler: async (a) => {
            const expression = String(a.expression ?? "");
            try {
              const v = evaluate(expression);
              return { status: "done", text: T(`${expression.trim().slice(0, 200)} = ${formatNumber(v, "fr")}`, `${expression.trim().slice(0, 200)} = ${formatNumber(v, "en")}`) };
            } catch (e) {
              if (e instanceof CalcError) return fail(T(`Calcul impossible : ${e.fr}`, `Cannot calculate: ${e.en}`));
              throw e;
            }
          },
        },
        {
          name: "date_math",
          description: "Calculs de dates et de durées, sans réseau : n'invente jamais une date ou un nombre de jours, utilise cet outil. op=diff : durée entre from et to (jours ; heures et minutes si les dates portent une heure). op=add : from + amount unités (unit : minutes, hours, days, weeks, months, years ; amount négatif pour le passé : « dans 45 jours » = 45 days, « il y a 3 semaines » = -3 weeks ; from vaut aujourd'hui s'il est omis). op=weekday : jour de la semaine de from (aujourd'hui si omis). op=workdays : jours ouvrés (lundi au vendredi, jours fériés non déduits) entre from et to, bornes comprises. Dates en AAAA-MM-JJ ou AAAA-MM-JJTHH:MM (heure locale) ; « today » et « now » sont acceptés. Calcule l'année à partir de la date du jour donnée dans ta consigne.",
          inputSchema: {
            type: "object",
            properties: {
              op: { type: "string", enum: [...OPS] },
              from: { type: "string", description: "Date de départ : 2026-11-10 ou 2026-11-10T14:30, today, now." },
              to: { type: "string", description: "Date d'arrivée (diff et workdays)." },
              amount: { type: "integer", description: "Nombre entier d'unités (add), négatif pour le passé." },
              unit: { type: "string", enum: [...UNITS], description: "Unité (add), days par défaut." },
            },
            required: ["op"],
          },
          level: "read",
          handler: async (a) => dateMath(a, now()),
        },
      ]);
    },
  });
}

export default createCalcPlugin();
