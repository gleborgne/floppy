// Les données d'un dossier de travail d'AVANT le renommage (plugin `veille`, dossier `veille/`, base aux noms français, tâche
// `quotidienne`), migrées par `floppy migrate`, puis lues par le vrai plugin sous ses nouveaux noms.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel, MemorySecrets, loadConfigFile, tr } from "@floppy/core";
import { migrateHome } from "@floppy/setup";
import { createWatchPlugin } from "../src/index.ts";
import { WatchDb } from "../src/store.ts";

const homes: string[] = [];
let k: Kernel | undefined;
afterEach(async () => { await k?.stopAll(); k = undefined; for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

/** Un dossier de travail à l'ancien format, tel que Floppy l'avait écrit : données réelles de la veille. */
function oldHome(): string {
  const home = mkdtempSync(join(tmpdir(), "floppy-watch-migration-"));
  homes.push(home);
  mkdirSync(join(home, "items"), { recursive: true });
  mkdirSync(join(home, "veille"), { recursive: true });
  writeFileSync(join(home, "floppy.yml"), [
    "# ma veille",
    "plugins:",
    "  - id: veille",
    "    plugin: veille",
    "    config:",
    "      interests:",
    "        ia-locale: { name: IA locale, feeds: ['https://blog.ai/rss'] }",
    "",
  ].join("\n"));
  writeFileSync(join(home, "tasks.json"), JSON.stringify({ "veille/quotidienne": { lastRun: "2026-11-09T07:30:00.000Z" } }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ "tasks.veille.quotidienne": "08:00 mon-fri" }));
  writeFileSync(join(home, "items", "veille.json"), JSON.stringify({ added: { llm: { kind: "interest", values: { name: "LLM locaux", queries: ["llama.cpp"] } } }, edits: {}, disabled: [], removed: [], children: {}, extra: {} }));
  const db = new DatabaseSync(join(home, "veille", "veille.db"));
  db.exec(`
    CREATE TABLE vus (url TEXT PRIMARY KEY, titre TEXT, interet TEXT, vu_le TEXT);
    CREATE TABLE digest (numero INTEGER PRIMARY KEY, doc TEXT, interet TEXT, titre TEXT, url TEXT, source TEXT, resume TEXT);
    INSERT INTO vus VALUES ('https://blog.ai/gemma5', 'Gemma 5 sort', 'ia-locale', '${new Date().toISOString()}');
    INSERT INTO digest VALUES (3, 'doc1', 'ia-locale', 'Gemma 5 sort', 'https://blog.ai/gemma5', 'Blog IA', 'Un nouveau modèle ouvert.');
  `);
  db.close();
  return home;
}

describe("plugin watch sur des données migrées", () => {
  it("retrouve sa base, sa tâche et ses éléments sous les nouveaux noms, sans repli sur les anciens", async () => {
    const home = oldHome();
    const reports = migrateHome(home);
    expect(reports.filter((r) => r.error)).toEqual([]);
    // Plus rien sous les anciens noms.
    expect(existsSync(join(home, "veille"))).toBe(false);
    expect(existsSync(join(home, "items", "veille.json"))).toBe(false);

    const config = loadConfigFile(join(home, "floppy.yml"));
    expect(config.plugins.map((p) => [p.id, p.plugin])).toEqual([["watch", "watch"]]);
    k = new Kernel({ home, logger: () => {}, secrets: new MemorySecrets(), plugins: [createWatchPlugin()] });
    await k.applyConfig(config);

    // La tâche : sa clé et son dernier passage viennent de tasks.json migré ; sa planification, de settings.json migré.
    const task = k.tasks.list().find((t) => t.key === "watch/daily");
    expect(task?.lastRun).toBe("2026-11-09T07:30:00.000Z");
    expect(k.settings.savedValue("tasks.watch.daily")).toBe("08:00 mon-fri");

    // La base : le dernier digest et ses articles, avec les nouveaux noms de colonnes.
    const article = await k.tools.call("watch_article", { article: 3 });
    expect(article.status).toBe("done");
    expect(tr(article.text, "fr")).toContain("3. Gemma 5 sort (Blog IA)\nUn nouveau modèle ouvert.");

    // Les éléments ajoutés dans la fenêtre (items/watch.json) : le centre d'intérêt est là, avec ceux de la config.
    const interests = (await k.items.snapshot()).find((p) => p.id === "watch-interests")!.items.map((i) => tr(i.label, "fr"));
    expect(interests).toEqual(expect.arrayContaining(["LLM locaux", "IA locale"]));
    expect(readFileSync(join(home, "watch", "watch.db")).length).toBeGreaterThan(0);

    // Le plugin n'a rien recréé sous l'ancien nom.
    expect(existsSync(join(home, "veille"))).toBe(false);
    const db = new WatchDb(join(home, "watch", "watch.db"));
    expect(db.seen("https://blog.ai/gemma5")).toBe(true);
    db.close();
  });
});
