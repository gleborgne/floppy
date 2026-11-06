// Secrets (clés d'API, jetons) : rangés dans le Gestionnaire d'identification Windows (ou le trousseau de l'OS),
// jamais dans un fichier de config. Nom : « floppy:<nom> ».
// En test (ou si le trousseau manque), MemorySecrets garde les secrets en mémoire seulement.
import { createRequire } from "node:module";

export interface Secrets {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
}

export class MemorySecrets implements Secrets {
  private m = new Map<string, string>();
  get(name: string) { return this.m.get(name); }
  set(name: string, value: string) { this.m.set(name, value); }
  delete(name: string) { this.m.delete(name); }
  has(name: string) { return this.m.has(name); }
}

/**
 * Vue cloisonnée du coffre pour un plugin : seuls les noms « <id du manifeste>/… » sont permis (lecture, écriture,
 * suppression). Les noms déjà utilisés (llm-openai/…, m365/…, tools/…) suivent cette règle : rien à migrer.
 */
export function scopedSecrets(inner: Secrets, plugin: string): Secrets {
  const prefix = `${plugin}/`;
  const check = (name: string): string => {
    if (typeof name !== "string" || !name.startsWith(prefix) || name.length === prefix.length || name.split("/").some((s) => s === "..")) {
      throw new Error(`secret « ${String(name)} » refusé : le plugin ${plugin} ne peut utiliser que les noms « ${prefix}… »`);
    }
    return name;
  };
  return {
    get: (name) => inner.get(check(name)),
    set: (name, value) => inner.set(check(name), value),
    delete: (name) => inner.delete(check(name)),
    has: (name) => inner.has(check(name)),
  };
}

interface KeyringEntry { getPassword(): string | null; setPassword(v: string): void; deletePassword(): boolean }

export class OsSecrets implements Secrets {
  private readonly Entry: new (service: string, user: string) => KeyringEntry;
  private readonly service: string;

  constructor(service = "floppy") {
    const req = createRequire(import.meta.url);
    this.Entry = (req("@napi-rs/keyring") as { Entry: OsSecrets["Entry"] }).Entry;
    this.service = service;
  }

  private entry(name: string) { return new this.Entry(this.service, name); }
  private raw(name: string): string | undefined {
    try { return this.entry(name).getPassword() ?? undefined; } catch { return undefined; }
  }

  // Le Gestionnaire d'identification Windows limite une entrée à 2560 octets (1280 caractères UTF-16).
  // Un secret plus long (jeton Microsoft…) est coupé en morceaux : « nom » = « chunks:N », puis « nom#0 », « nom#1 »…
  get(name: string) {
    const head = this.raw(name);
    const m = /^chunks:(\d+)$/.exec(head ?? "");
    if (!m) return head;
    let out = "";
    for (let i = 0; i < Number(m[1]); i++) {
      const part = this.raw(`${name}#${i}`);
      if (part === undefined) return undefined;
      out += part;
    }
    return out;
  }
  set(name: string, value: string) {
    this.delete(name);
    if (value.length <= CHUNK) { this.entry(name).setPassword(value); return; }
    const n = Math.ceil(value.length / CHUNK);
    for (let i = 0; i < n; i++) this.entry(`${name}#${i}`).setPassword(value.slice(i * CHUNK, (i + 1) * CHUNK));
    this.entry(name).setPassword(`chunks:${n}`);
  }
  delete(name: string) {
    const m = /^chunks:(\d+)$/.exec(this.raw(name) ?? "");
    if (m) for (let i = 0; i < Number(m[1]); i++) { try { this.entry(`${name}#${i}`).deletePassword(); } catch { /* absent */ } }
    try { this.entry(name).deletePassword(); } catch { /* absent */ }
  }
  has(name: string) { return this.get(name) !== undefined; }
}

const CHUNK = 1000;

/** Trousseau de l'OS si possible, sinon mémoire (avec un avertissement). */
export function defaultSecrets(warn?: (msg: string) => void): Secrets {
  try {
    return new OsSecrets();
  } catch (e) {
    warn?.(`trousseau indisponible (${e instanceof Error ? e.message : String(e)}) : secrets gardés en mémoire seulement`);
    return new MemorySecrets();
  }
}
