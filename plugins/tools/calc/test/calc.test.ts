import { describe, it, expect, afterEach } from "vitest";
import { Kernel, tr } from "@floppy/core";
import { createCalcPlugin, dateMath } from "../src/index.ts";
import { evaluate } from "../src/expr.ts";
import { addDuration, workdaysBetween, parseWhen } from "../src/dates.ts";

let kernels: Kernel[] = [];
afterEach(async () => { for (const k of kernels) await k.stopAll(); kernels = []; });

// 2026-11-10 est un mardi.
const NOW = new Date(2026, 10, 10, 9, 30);

async function start() {
  const k = new Kernel({ logger: () => {}, plugins: [createCalcPlugin(() => NOW)] });
  kernels.push(k);
  await k.applyConfig({ plugins: [{ id: "calc", plugin: "calc" }] });
  return k;
}

describe("evaluate", () => {
  it.each([
    ["1+2*3", 7],
    ["(1+2)*3", 9],
    ["10/4", 2.5],
    ["0.1+0.2", 0.3],
    ["0,1 + 0,2", 0.3],
    ["7 % 3", 1],
    ["2^10", 1024],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["2^-1", 0.5],
    ["2**3", 8],
    ["-(3+4)", -7],
    ["15% de 240", 36],
    ["15% of 240", 36],
    ["15%*240", 36],
    ["240*15%", 36],
    ["50%", 0.5],
    ["10 % 4", 2],
    ["sqrt(16)", 4],
    ["racine(9)", 3],
    ["round(2.5)", 3],
    ["round(1.005; 2)", 1.01],
    ["round(3.14159, 2)", 3.14],
    ["floor(2.9)+ceil(2.1)", 5],
    ["min(4;2;8)", 2],
    ["max(2,5)", 5],
    ["max(1,5; 3)", 5],
    ["abs(-3.5)", 3.5],
    ["pi", Math.PI],
    ["1200 × 1,2", 1440],
    ["1 200", undefined],
    ["1/3*3", 1],
    ["1e", undefined],
  ])("%s", (expr, want) => {
    if (want === undefined) expect(() => evaluate(expr)).toThrow();
    else expect(evaluate(expr)).toBeCloseTo(want, 10);
  });

  it("résultat propre, sans bruit de virgule flottante", () => {
    expect(evaluate("0.1*3")).toBe(0.3);
    expect(evaluate("1.1+2.2")).toBe(3.3);
    expect(evaluate("0-0")).toBe(0);
    expect(Object.is(evaluate("-0*5"), 0)).toBe(true);
  });

  it("erreurs claires", () => {
    expect(() => evaluate("1/0")).toThrow(/Division par zéro/);
    expect(() => evaluate("5 % 0")).toThrow(/Modulo/);
    expect(() => evaluate("")).toThrow(/vide/);
    expect(() => evaluate("2 +")).toThrow(/incompl/);
    expect(() => evaluate("(1+2")).toThrow(/Parenthèse/);
    expect(() => evaluate("1+2)")).toThrow(/invalide/);
    expect(() => evaluate("sqrt(-1)")).toThrow(/négatif/);
    expect(() => evaluate("foo(1)")).toThrow(/Fonction inconnue/);
    expect(() => evaluate("abc")).toThrow(/Mot inconnu/);
    expect(() => evaluate("1..2")).toThrow();
    expect(() => evaluate("1.2.3")).toThrow(/Nombre invalide/);
    expect(() => evaluate("2 $ 3")).toThrow(/Caractère/);
    expect(() => evaluate("round(1;2;3)")).toThrow(/argument/);
    expect(() => evaluate("round(1; 99)")).toThrow(/décimales/);
    expect(() => evaluate("10^400")).toThrow(/fini/);
    expect(() => evaluate("1+".repeat(300))).toThrow(/trop longue/);
    expect(() => evaluate("(".repeat(100) + "1" + ")".repeat(100))).toThrow(/imbriquée/);
  });

  it("n'exécute jamais de code", () => {
    for (const bad of ["process.exit(1)", "constructor", "this", "globalThis", "require('fs')", "__proto__", "1; alert(1)"]) {
      expect(() => evaluate(bad)).toThrow();
    }
  });
});

describe("outil calculate", () => {
  it("résultat bilingue, niveau lecture", async () => {
    const k = await start();
    expect(k.tools.list().find((t) => t.name === "calculate")!.level).toBe("read");
    const r = await k.tools.call("calculate", { expression: "15% de 240,5" });
    expect(r.status).toBe("done");
    expect(String(r.text)).toContain("36,075");
    const bad = await k.tools.call("calculate", { expression: "1/0" });
    expect(bad.status).toBe("failed");
    expect(JSON.stringify(bad.text)).toContain("Division par zéro");
  });
});

const dm = (a: Record<string, unknown>) => {
  const r = dateMath(a, NOW);
  return { status: r.status, fr: tr(r.text, "fr"), en: tr(r.text, "en") };
};

describe("date_math", () => {
  it("diff en jours (calendrier)", () => {
    expect(dm({ op: "diff", from: "2026-11-10", to: "2026-12-25" }).fr).toBe("Du 2026-11-10 au 2026-12-25 : 45 jour(s) (6 semaine(s) et 3 jour(s)).");
    expect(dm({ op: "diff", from: "2026-03-28", to: "2026-03-30" }).fr).toContain(": 2 jour(s)"); // passage à l'heure d'été
    expect(dm({ op: "diff", from: "2026-12-25", to: "2026-11-10" }).fr).toContain("-45 jour(s)");
    expect(dm({ op: "diff", from: "2026-12-25", to: "2026-11-10" }).fr).toContain("avant la première");
    expect(dm({ op: "diff", from: "2026-11-10", to: "today" }).fr).toContain(": 0 jour(s)");
  });

  it("diff avec heures", () => {
    const r = dm({ op: "diff", from: "2026-11-10T08:00", to: "2026-11-11T10:30" });
    expect(r.fr).toContain("1 jour(s) 2 h 30 min (soit 26,5 heures, 1590 minutes)");
    expect(r.en).toContain("26.5 hours");
    expect(dm({ op: "diff", from: "2026-11-10T08:00", to: "now" }).fr).toContain("0 jour(s) 1 h 30 min");
    expect(dm({ op: "diff", from: "2026-11-10T10:00", to: "2026-11-10T09:00" }).fr).toContain("-0 jour(s) 1 h 0 min");
  });

  it("add : dans 45 jours, il y a 3 semaines", () => {
    expect(dm({ op: "add", from: "2026-11-10", amount: 45, unit: "days" }).fr).toBe("2026-11-10 + 45 jours = 2026-12-25 (vendredi).");
    expect(dm({ op: "add", amount: -3, unit: "weeks" }).fr).toBe("2026-11-10 - 3 semaines = 2026-10-20 (mardi).");
    expect(dm({ op: "add", amount: -3, unit: "weeks" }).en).toBe("2026-11-10 - 3 weeks = 2026-10-20 (Tuesday).");
    expect(dm({ op: "add", amount: 1 }).fr).toContain("+ 1 jour =");
    expect(dm({ op: "add", amount: 90, unit: "minutes" }).fr).toBe("2026-11-10T09:30 + 90 minutes = 2026-11-10T11:00 (mardi).");
    expect(dm({ op: "add", from: "2026-11-10T23:00", amount: 2, unit: "hours" }).fr).toContain("= 2026-11-11T01:00");
  });

  it("add : mois et années restent dans le mois, bissextile", () => {
    expect(addDuration(new Date(2026, 0, 31), 1, "months")).toEqual(new Date(2026, 1, 28));
    expect(addDuration(new Date(2028, 0, 31), 1, "months")).toEqual(new Date(2028, 1, 29));
    expect(addDuration(new Date(2028, 1, 29), 1, "years")).toEqual(new Date(2029, 1, 28));
    expect(addDuration(new Date(2026, 10, 30), -3, "months")).toEqual(new Date(2026, 7, 30));
    expect(addDuration(new Date(2026, 11, 15), 2, "months")).toEqual(new Date(2027, 1, 15));
  });

  it("weekday", () => {
    expect(dm({ op: "weekday", from: "2026-11-10" }).fr).toBe("Le 2026-11-10 est un mardi.");
    expect(dm({ op: "weekday", from: "2026-07-14" }).en).toBe("2026-07-14 is a Tuesday.");
    expect(dm({ op: "weekday" }).fr).toContain("mardi");
  });

  it("workdays : bornes comprises, week-ends exclus", () => {
    // lundi 9 au vendredi 13 : 5 ; du lundi 9 au lundi 16 : 6
    expect(workdaysBetween(new Date(2026, 10, 9), new Date(2026, 10, 13))).toBe(5);
    expect(workdaysBetween(new Date(2026, 10, 9), new Date(2026, 10, 16))).toBe(6);
    expect(workdaysBetween(new Date(2026, 10, 14), new Date(2026, 10, 15))).toBe(0); // samedi-dimanche
    expect(workdaysBetween(new Date(2026, 10, 10), new Date(2026, 10, 10))).toBe(1);
    expect(workdaysBetween(new Date(2026, 10, 1), new Date(2026, 10, 30))).toBe(21);
    expect(workdaysBetween(new Date(2026, 10, 16), new Date(2026, 10, 9))).toBe(-6);
    expect(dm({ op: "workdays", from: "2026-11-09", to: "2026-11-27" }).fr).toContain("15 jour(s) ouvré(s)");
  });

  it("entrées invalides : erreurs claires, bilingues", () => {
    expect(dm({ op: "nope" }).status).toBe("failed");
    expect(dm({ op: "diff", from: "10/11/2026", to: "2026-11-12" }).fr).toContain("illisible");
    expect(dm({ op: "diff", from: "2026-02-30", to: "2026-03-01" }).fr).toContain("n'existe pas");
    expect(dm({ op: "diff", from: "2026-02-30", to: "2026-03-01" }).en).toContain("does not exist");
    expect(dm({ op: "diff", from: "2026-13-01T10:00", to: "2026-03-01" }).status).toBe("failed");
    expect(dm({ op: "diff", from: "2026-11-10" }).fr).toContain("to manquante");
    expect(dm({ op: "add", amount: 1.5 }).status).toBe("failed");
    expect(dm({ op: "add" }).status).toBe("failed");
    expect(dm({ op: "add", amount: 1, unit: "decades" }).status).toBe("failed");
    expect(dm({ op: "add", amount: 99_999_999 }).status).toBe("failed");
    expect(() => parseWhen("2026-11-10T25:00", NOW)).toThrow();
  });

  it("outil enregistré en lecture, avec l'horloge injectée", async () => {
    const k = await start();
    expect(k.tools.list().find((t) => t.name === "date_math")!.level).toBe("read");
    const r = await k.tools.call("date_math", { op: "add", amount: 45, unit: "days" });
    expect(r.status).toBe("done");
    expect(JSON.stringify(r.text)).toContain("2026-12-25");
  });
});
