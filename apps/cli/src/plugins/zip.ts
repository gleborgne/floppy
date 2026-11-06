// Lecture d'une archive zip, sans dépendance : juste ce qu'il faut pour un plugin (méthodes « stocké » et « deflate »).
// Prudence : chemins qui sortent du dossier, archives chiffrées, zip64, liens et bombes de décompression sont refusés.
import { inflateRawSync } from "node:zlib";
import { T, TextError } from "@floppy/core";

export interface ZipLimits {
  maxEntries: number;
  /** Taille totale décompressée maximale (octets). */
  maxTotal: number;
  /** Taille maximale d'un fichier décompressé (octets). */
  maxFile: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 500, maxTotal: 5_000_000, maxFile: 1_000_000 };

export interface ZipFile {
  /** Chemin relatif, séparé par « / ». */
  path: string;
  data: Buffer;
}

const fail = (fr: string, en: string): never => { throw new TextError(T(`archive zip : ${fr}`, `zip archive: ${en}`)); };

/** Chemin sûr (relatif, sans « .. », sans lecteur), ou undefined. */
export function safeZipPath(name: string): string | undefined {
  const p = name.replaceAll("\\", "/");
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.includes("\0")) return undefined;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return undefined;
  return parts.join("/");
}

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipFile[] {
  // Fin du répertoire central : cherchée depuis la fin (commentaire de 64 Ko au plus).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail("fin du répertoire introuvable (fichier abîmé ou pas un zip)", "end of directory not found (damaged file or not a zip)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) fail("format zip64 non pris en charge", "zip64 is not supported");
  if (count > limits.maxEntries) fail(`trop de fichiers (${count})`, `too many files (${count})`);

  const out: ZipFile[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail("répertoire central abîmé", "damaged central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // dossier
    if (flags & 1) fail(`fichier chiffré : ${name}`, `encrypted file: ${name}`);
    // Lien symbolique (attributs Unix S_IFLNK) : refusé.
    if (((extAttr >>> 16) & 0o170000) === 0o120000) fail(`lien symbolique refusé : ${name}`, `symbolic link refused: ${name}`);
    const path = safeZipPath(name);
    if (!path) fail(`chemin refusé : ${name}`, `path refused: ${name}`);
    if (usize > limits.maxFile) fail(`fichier trop gros : ${name}`, `file too large: ${name}`);
    total += usize;
    if (total > limits.maxTotal) fail("contenu trop gros", "content too large");

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) fail(`entête abîmée : ${name}`, `damaged header: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) fail(`fichier tronqué : ${name}`, `truncated file: ${name}`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }); } catch { return fail(`décompression impossible : ${name}`, `cannot decompress: ${name}`); }
    } else return fail(`méthode de compression ${method} non prise en charge`, `compression method ${method} is not supported`);
    if (data.length !== usize) fail(`taille inattendue : ${name}`, `unexpected size: ${name}`);
    out.push({ path: path!, data });
  }
  return stripCommonRoot(out);
}

/** Archive d'un dépôt (« depot-main/… ») : le dossier commun du haut est retiré. */
export function stripCommonRoot(files: ZipFile[]): ZipFile[] {
  if (!files.length) return files;
  const first = files[0]!.path.split("/")[0]!;
  if (!files.every((f) => f.path.startsWith(first + "/"))) return files;
  return files.map((f) => ({ path: f.path.slice(first.length + 1), data: f.data }));
}
