// Réglages modifiables en parlant à l'assistant (« Floppy, prends une voix de femme »), ou par la CLI.
//
// - Chaque plugin déclare ses réglages : clé, libellé, valeurs possibles, risque, et comment les appliquer à chaud.
// - Risque (docs/spec/fonctionnement.md, « Config à la voix ») :
//     free  = appliqué tout de suite, annulable (« Floppy, annule ») ;
//     ask   = demande d'accord avant (ex. activer un service cloud) ;
//     cli   = jamais à la voix : CLI ou clic seulement (ex. tout ce qui touche aux droits).
// - Les valeurs choisies sont gardées dans <home>/settings.json et reprises au démarrage.
// - Le cerveau a 3 outils internes : lister_reglages, changer_reglage, annuler_reglage. Le contrôle du risque est
//   fait ICI, par le code (le modèle ne peut pas le contourner) ; chaque changement est journalisé.
import { readJsonFile, writeJsonAtomic } from "./util/files.ts";
import type { ApprovalManager } from "./approval.ts";
import type { Audit } from "./audit.ts";
import { allTexts, errorText, T, tr, type Text } from "./i18n.ts";

export type SettingRisk = "free" | "ask" | "cli";

export interface SettingOption {
  value: string;
  label: Text;
  /** Mots qui désignent cette valeur à l'oral (« femme », « grave »…). */
  aliases?: string[];
  /** Choisir cette valeur prend du temps (charger un modèle) : la voie rapide de la conversation le dit avant. */
  slow?: boolean;
}

export interface SettingDef {
  key: string;
  label: Text;
  description: Text;
  type: "enum" | "number" | "boolean" | "text";
  /** Id d'une rubrique de la fenêtre (voir sections.ts : déclarée par le noyau ou par un plugin). Inconnue : « plugins ». */
  section: string;
  /** Bloc dans la rubrique (« Ton », « Affichage »…). */
  group?: Text;
  /**
   * Rôle fonctionnel (chaîne libre) : la fenêtre met en avant les réglages d'un rôle connu sans connaître leur clé.
   * Valeurs documentées : "brain.main" (cerveau principal), "brain.delegate" (délégation), "brain.mode" (séparé / live).
   */
  role?: string;
  options?: SettingOption[];
  min?: number;
  max?: number;
  /** Texte : longueur maximale. Choix : suggestions (préréglages) pour un texte libre. */
  maxLength?: number;
  presets?: SettingOption[];
  risk: SettingRisk;
  /** Risque selon la valeur demandée (ex. allumer un connecteur cloud = ask, l'éteindre = free). */
  riskFor?: (value: unknown) => SettingRisk;
  get(): unknown;
  /** Applique la valeur à chaud. Peut prendre du temps (charger un modèle). */
  set(value: unknown): void | Promise<void>;
}

export interface SettingInfo {
  key: string;
  label: Text;
  description: Text;
  type: SettingDef["type"];
  section: string;
  group: Text;
  role?: string;
  value: unknown;
  options?: SettingOption[];
  presets?: SettingOption[];
  maxLength?: number;
  min?: number;
  max?: number;
  risk: SettingRisk;
  source: string;
}

/** Résultat d'un changement : le message est dans la langue de l'origine (interface pour ui/cli, assistant pour la voix). */
export interface ChangeResult {
  ok: boolean;
  text: string;
}
/** Résultat interne, avant le choix de la langue. */
interface ChangeText {
  ok: boolean;
  text: Text;
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export class SettingsRegistry {
  private defs = new Map<string, { def: SettingDef; source: string }>();
  private saved: Record<string, unknown> = {};
  private history: { key: string; before: unknown; after: unknown }[] = [];
  private listeners = new Set<() => void>();
  private readonly file: string;
  private readonly approvals: ApprovalManager;
  private readonly audit: Audit;

  /** Langue d'un message selon l'origine : assistant (voix) ou interface (cli, ui). */
  private readonly lang: (via: "voice" | "cli" | "ui") => string;

  constructor(file: string, approvals: ApprovalManager, audit: Audit, lang: (via: "voice" | "cli" | "ui") => string = () => "fr") {
    this.file = file;
    this.approvals = approvals;
    this.audit = audit;
    this.lang = lang;
    const saved = readJsonFile<Record<string, unknown>>(file);
    this.saved = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  /** Valeur gardée d'un démarrage précédent (le plugin l'applique au démarrage). */
  savedValue<T>(key: string): T | undefined {
    return this.saved[key] as T | undefined;
  }

  /** Valeurs gardées dont la clé commence par `prefix` (plugin isolé : copie envoyée à son processus). */
  savedEntries(prefix: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.saved)) if (prefix && k.startsWith(prefix)) out[k] = v;
    return out;
  }

  declare(source: string, defs: SettingDef[]): () => void {
    for (const d of defs) {
      const cur = this.defs.get(d.key);
      if (cur) throw new Error(`réglage ${d.key} déjà déclaré par ${cur.source}`);
    }
    for (const d of defs) this.defs.set(d.key, { def: d, source });
    this.changed();
    return () => {
      for (const d of defs) if (this.defs.get(d.key)?.def === d) this.defs.delete(d.key);
      this.changed();
    };
  }

  list(): SettingInfo[] {
    return [...this.defs.values()].map(({ def, source }) => ({
      key: def.key, label: def.label, description: def.description, type: def.type, section: def.section || "general", group: def.group ?? { fr: "Général", en: "General" }, value: def.get(),
      ...(def.role ? { role: def.role } : {}),
      ...(def.options ? { options: def.options } : {}), ...(def.presets ? { presets: def.presets } : {}),
      ...(def.maxLength !== undefined ? { maxLength: def.maxLength } : {}), ...(def.min !== undefined ? { min: def.min } : {}),
      ...(def.max !== undefined ? { max: def.max } : {}), risk: def.risk, source,
    }));
  }

  /** Réglages d'un rôle (ex. "brain.main"), dans l'ordre de déclaration. */
  byRole(role: string): SettingInfo[] {
    return this.list().filter((s) => s.role === role);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Lit une valeur dite à l'oral : « femme », « anna », « 10 », « oui »… Message d'erreur dans la langue `lang`. */
  parse(def: SettingDef, raw: unknown, lang = "fr"): { ok: true; value: unknown } | { ok: false; text: string } {
    const m = (fr: string, en: string) => (lang === "en" ? en : fr);
    const name = tr(def.label, lang);
    if (def.type === "enum") {
      const r = norm(String(raw ?? ""));
      const opts = def.options ?? [];
      const labels = (o: SettingOption) => allTexts(o.label).map(norm);
      const hit = opts.find((o) => norm(o.value) === r)
        ?? opts.find((o) => labels(o).includes(r))
        ?? opts.find((o) => (o.aliases ?? []).some((a) => norm(a) === r))
        ?? opts.find((o) => labels(o).some((l) => l.includes(r)) || (o.aliases ?? []).some((a) => r.includes(norm(a))));
      const choices = opts.map((o) => tr(o.label, lang)).join(", ");
      if (!hit) return { ok: false, text: m(`Valeur inconnue pour ${name}. Choix possibles : ${choices}.`, `Unknown value for ${name}. Possible choices: ${choices}.`) };
      return { ok: true, value: hit.value };
    }
    if (def.type === "number") {
      const n = Number(String(raw).replace(",", ".").replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, text: m(`${name} : un nombre est attendu.`, `${name}: a number is expected.`) };
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        return { ok: false, text: m(`${name} : entre ${def.min} et ${def.max}.`, `${name}: between ${def.min} and ${def.max}.`) };
      }
      return { ok: true, value: n };
    }
    if (def.type === "text") {
      const t = String(raw ?? "").trim();
      if (!t && def.min !== 0) return { ok: false, text: m(`${name} : texte vide.`, `${name}: empty text.`) };
      const max = def.maxLength ?? 400;
      if (t.length > max) return { ok: false, text: m(`${name} : ${max} caractères au plus.`, `${name}: ${max} characters at most.`) };
      const preset = def.presets?.find((o) => norm(o.value) === norm(t) || allTexts(o.label).some((l) => norm(l) === norm(t)));
      return { ok: true, value: preset ? preset.value : t };
    }
    const b = norm(String(raw));
    if (["true", "oui", "yes", "on", "active", "activer", "enable", "enabled", "1"].includes(b)) return { ok: true, value: true };
    if (["false", "non", "no", "off", "desactive", "desactiver", "disable", "disabled", "0"].includes(b)) return { ok: true, value: false };
    return { ok: false, text: m(`${name} : oui ou non.`, `${name}: yes or no.`) };
  }

  /**
   * Change un réglage. `via` : « voice » (demandé à l'assistant), « cli » ou « ui ».
   * Le risque est contrôlé ici : cli = refusé à la voix ; ask = accord de l'utilisateur ; free = tout de suite.
   * Le message est dans la langue de l'assistant (voix) ou de l'interface (cli, ui).
   */
  async change(key: string, raw: unknown, via: "voice" | "cli" | "ui", origin?: string): Promise<ChangeResult> {
    const lang = this.lang(via);
    const m = (fr: string, en: string) => (lang === "en" ? en : fr);
    const entry = this.defs.get(key) ?? [...this.defs.values()].find((e) => allTexts(e.def.label).some((l) => norm(l) === norm(key)));
    if (!entry) return { ok: false, text: m(`Réglage inconnu : ${key}. Réglages : ${[...this.defs.keys()].join(", ")}.`, `Unknown setting: ${key}. Settings: ${[...this.defs.keys()].join(", ")}.`) };
    const { def } = entry;
    const name = tr(def.label, lang);
    const parsed = this.parse(def, raw, lang);
    if (!parsed.ok) return { ok: false, text: parsed.text };
    const before = def.get();
    if (before === parsed.value) return { ok: true, text: m(`${name} est déjà sur ${this.label(def, parsed.value, lang)}.`, `${name} is already set to ${this.label(def, parsed.value, lang)}.`) };
    const refused = await this.gate(def, before, parsed.value, via, origin);
    if (refused) return { ok: false, text: tr(refused.text, lang) };
    try {
      await def.set(parsed.value);
    } catch (e) {
      const why = tr(errorText(e), lang);
      return { ok: false, text: m(`Le réglage n'a pas pu être appliqué : ${why}`, `The setting could not be applied: ${why}`) };
    }
    this.history.push({ key: def.key, before, after: parsed.value });
    this.saved[def.key] = parsed.value;
    this.persist();
    this.audit.write({ kind: "setting", key: def.key, before, after: parsed.value, via });
    this.changed();
    return { ok: true, text: `${name}${m(" : ", ": ")}${this.label(def, parsed.value, lang)}.` };
  }

  /** Contrôle du risque (change ET undo). Retourne un refus, ou undefined si c'est permis. */
  private async gate(def: SettingDef, before: unknown, value: unknown, via: "voice" | "cli" | "ui", origin?: string): Promise<ChangeText | undefined> {
    const risk = def.riskFor ? def.riskFor(value) : def.risk;
    if (via === "voice" && risk === "cli") {
      this.audit.write({ kind: "setting.refused", key: def.key, value, why: "cli seulement" });
      return { ok: false, text: T(`Ce réglage ne se change pas à la voix, pour ta sécurité : utilise la CLI (floppy set ${def.key} …).`, `This setting can't be changed by voice, for your safety: use the CLI (floppy set ${def.key} …).`) };
    }
    if (via === "voice" && risk === "ask") {
      // override « ask » : `approvals.write: always` ne dispense pas de demander l'accord.
      const d = await this.approvals.check({
        tool: "changer_reglage", args: { cle: def.key, valeur: value }, level: "write", override: "ask",
        summary: T(`${tr(def.label, "fr")} : ${this.label(def, before, "fr")} → ${this.label(def, value, "fr")}`, `${tr(def.label, "en")}: ${this.label(def, before, "en")} → ${this.label(def, value, "en")}`),
        ...(origin ? { origin } : {}),
      });
      if (!d.ok) return { ok: false, text: T("Refusé par l'utilisateur. Le réglage n'a pas changé. Ne le retente pas.", "Refused by the user. The setting did not change. Do not try again.") };
    }
    return undefined;
  }

  /**
   * Annule le dernier changement (« Floppy, annule »). La valeur rétablie passe par le même contrôle du risque que
   * change() : à la voix, un réglage « cli » ne s'annule pas et un « ask » demande l'accord (l'entrée reste alors annulable).
   */
  async undo(via: "voice" | "cli" | "ui" = "voice", origin?: string): Promise<ChangeResult> {
    const lang = this.lang(via);
    const m = (fr: string, en: string) => (lang === "en" ? en : fr);
    const last = this.history[this.history.length - 1];
    if (!last) return { ok: false, text: m("Aucun réglage à annuler.", "No setting to undo.") };
    const entry = this.defs.get(last.key);
    if (!entry) { this.history.pop(); return { ok: false, text: m("Ce réglage n'existe plus.", "This setting no longer exists.") }; }
    const refused = await this.gate(entry.def, entry.def.get(), last.before, via, origin);
    if (refused) return { ok: false, text: tr(refused.text, lang) };
    if (this.history[this.history.length - 1] !== last) return { ok: false, text: m("Un autre changement a eu lieu entre-temps. Rien n'a été annulé.", "Another change happened in the meantime. Nothing was undone.") };
    this.history.pop();
    try { await entry.def.set(last.before); } catch (e) { const why = tr(errorText(e), lang); return { ok: false, text: m(`Annulation impossible : ${why}`, `Cannot undo: ${why}`) }; }
    this.saved[last.key] = last.before;
    this.persist();
    this.audit.write({ kind: "setting.undo", key: last.key, back_to: last.before });
    this.changed();
    const name = tr(entry.def.label, lang);
    return { ok: true, text: m(`Annulé : ${name} revient à ${this.label(entry.def, last.before, lang)}.`, `Undone: ${name} is back to ${this.label(entry.def, last.before, lang)}.`) };
  }

  label(def: SettingDef, v: unknown, lang = "fr"): string {
    if (def.type === "enum") return tr(def.options?.find((o) => o.value === v)?.label, lang) || String(v);
    if (def.type === "boolean") return v ? (lang === "en" ? "yes" : "oui") : (lang === "en" ? "no" : "non");
    if (def.type === "text") return tr(def.presets?.find((o) => o.value === v)?.label, lang) || String(v);
    return String(v);
  }

  /** Valeur courante d'un réglage (pour un autre plugin, ex. le ton lu par le cerveau CLI). */
  value(key: string): unknown {
    return this.defs.get(key)?.def.get();
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.saved);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* rien */ } }
  }
}
