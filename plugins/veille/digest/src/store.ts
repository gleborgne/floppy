// Base de la veille (<home>/veille/veille.db, SQLite) :
// - vus : chaque article déjà vu (clé = adresse normalisée), pour ne garder que les nouveaux. Oubliés après 90 jours.
// - digest : les articles numérotés du dernier digest, pour « le 3 ne m'intéresse pas ».
import { DatabaseSync } from "node:sqlite";

export interface DigestArticle {
  numero: number;
  doc: string;
  interet: string;
  titre: string;
  url: string;
  source: string;
  resume: string;
}

export class VeilleDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vus (url TEXT PRIMARY KEY, titre TEXT, interet TEXT, vu_le TEXT);
      CREATE TABLE IF NOT EXISTS digest (numero INTEGER PRIMARY KEY, doc TEXT, interet TEXT, titre TEXT, url TEXT, source TEXT, resume TEXT);
    `);
  }

  seen(url: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM vus WHERE url = ?").get(url);
  }

  markSeen(list: { url: string; titre: string; interet: string }[], now = new Date()): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO vus (url, titre, interet, vu_le) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const a of list) ins.run(a.url, a.titre, a.interet, now.toISOString());
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.db.prepare("DELETE FROM vus WHERE vu_le < ?").run(new Date(now.getTime() - 90 * 86_400_000).toISOString());
  }

  /** Remplace le dernier digest. */
  setDigest(list: DigestArticle[]): void {
    const ins = this.db.prepare("INSERT INTO digest (numero, doc, interet, titre, url, source, resume) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM digest");
      for (const a of list) ins.run(a.numero, a.doc, a.interet, a.titre, a.url, a.source, a.resume);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  article(numero: number): DigestArticle | undefined {
    return this.db.prepare("SELECT * FROM digest WHERE numero = ?").get(numero) as DigestArticle | undefined;
  }

  digest(): DigestArticle[] {
    return this.db.prepare("SELECT * FROM digest ORDER BY numero").all() as unknown as DigestArticle[];
  }

  close(): void {
    this.db.close();
  }
}
