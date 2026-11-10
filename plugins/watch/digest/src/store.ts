// Base de la veille (<home>/watch/watch.db, SQLite) :
// - seen : chaque article déjà vu (clé = adresse normalisée), pour ne garder que les nouveaux. Oubliés après 90 jours.
// - digest : les articles numérotés du dernier digest, pour « le 3 ne m'intéresse pas ».
import { DatabaseSync } from "node:sqlite";

export interface DigestArticle {
  number: number;
  doc: string;
  interest: string;
  title: string;
  url: string;
  source: string;
  summary: string;
}

export class WatchDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (url TEXT PRIMARY KEY, title TEXT, interest TEXT, seen_at TEXT);
      CREATE TABLE IF NOT EXISTS digest (number INTEGER PRIMARY KEY, doc TEXT, interest TEXT, title TEXT, url TEXT, source TEXT, summary TEXT);
    `);
  }

  seen(url: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM seen WHERE url = ?").get(url);
  }

  markSeen(list: { url: string; title: string; interest: string }[], now = new Date()): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO seen (url, title, interest, seen_at) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const a of list) ins.run(a.url, a.title, a.interest, now.toISOString());
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.db.prepare("DELETE FROM seen WHERE seen_at < ?").run(new Date(now.getTime() - 90 * 86_400_000).toISOString());
  }

  /** Remplace le dernier digest. */
  setDigest(list: DigestArticle[]): void {
    const ins = this.db.prepare("INSERT INTO digest (number, doc, interest, title, url, source, summary) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM digest");
      for (const a of list) ins.run(a.number, a.doc, a.interest, a.title, a.url, a.source, a.summary);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  article(number: number): DigestArticle | undefined {
    return this.db.prepare("SELECT * FROM digest WHERE number = ?").get(number) as DigestArticle | undefined;
  }

  digest(): DigestArticle[] {
    return this.db.prepare("SELECT * FROM digest ORDER BY number").all() as unknown as DigestArticle[];
  }

  close(): void {
    this.db.close();
  }
}
