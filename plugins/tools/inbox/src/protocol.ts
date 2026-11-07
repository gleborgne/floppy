// Protocole de la boîte aux lettres (voir docs/spec/boite-aux-lettres.md). Les messages viennent d'autres
// programmes : chaque champ est vérifié et borné avant usage. Rien ici ne touche au réseau ni aux fichiers.
import type { Text } from "@floppy/core";

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Schéma de lien qu'une app peut déclarer (ex. « inwink-differendum »). */
export const SCHEME = /^[a-z][a-z0-9+.-]{1,40}$/;
export const MAX_NAME = 80;
export const MAX_TEXT = 500;
export const MAX_LABEL = 120;
export const MAX_URL = 2048;
export const MAX_KEY = 200;
export const MAX_SCHEMES = 5;

/** Schémas jamais acceptés : fichiers, scripts, contenus en ligne, réglages et commandes du système. */
export function forbiddenScheme(s: string): boolean {
  return ["file", "javascript", "data", "vbscript", "about", "blob", "http", "https", "shell", "search", "search-ms"].includes(s)
    || s.startsWith("ms-") || s.includes("shell");
}

export interface Hello { app: string; name: string; schemes: string[] }
export type Mode = "voix" | "info";
export interface Message {
  app: string;
  text: Text;
  mode: Mode;
  key?: string;
  action?: { label: Text; url: string };
}

const obj = (x: unknown): Record<string, unknown> | undefined =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;

/** Texte simple ou { fr, en } ; espaces repliés, longueur bornée. Rend undefined si vide ou invalide. */
export function cleanText(x: unknown, max: number): Text | undefined {
  const one = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return s && s.length <= max ? s : undefined;
  };
  if (typeof x === "string") return one(x);
  const o = obj(x);
  if (!o) return undefined;
  const fr = one(o.fr);
  const en = one(o.en);
  if (o.fr !== undefined && fr === undefined) return undefined;
  if (o.en !== undefined && en === undefined) return undefined;
  if (!fr && !en) return undefined;
  return { fr: fr ?? en!, ...(en ? { en } : {}) };
}

export function parseHello(x: unknown): Hello | string {
  const o = obj(x);
  if (!o) return "message invalide";
  if (typeof o.app !== "string" || !APP_ID.test(o.app)) return "app invalide";
  const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) return "name invalide";
  const raw = o.schemes ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_SCHEMES) return "schemes invalide";
  const schemes: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string") return "schemes invalide";
    const l = s.toLowerCase();
    if (!SCHEME.test(l) || forbiddenScheme(l)) return `schéma refusé : ${s}`;
    if (!schemes.includes(l)) schemes.push(l);
  }
  return { app: o.app, name, schemes };
}

/** Le lien d'une action : un schéma déclaré par l'app, ou https. Rend le lien normalisé, ou la raison du refus. */
export function checkActionUrl(raw: unknown, schemes: readonly string[]): string | { error: string } {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URL) return { error: "url invalide" };
  let u: URL;
  try { u = new URL(raw); } catch { return { error: "url invalide" }; }
  const s = u.protocol.replace(/:$/, "").toLowerCase();
  if (s === "https") return u.href;
  if (!schemes.includes(s) || forbiddenScheme(s)) return { error: `schéma non déclaré : ${s}` };
  return u.href;
}

export function parseMessage(x: unknown, schemes: readonly string[]): Message | string {
  const o = obj(x);
  if (!o) return "message invalide";
  if (typeof o.app !== "string" || !APP_ID.test(o.app)) return "app invalide";
  const text = cleanText(o.text, MAX_TEXT);
  if (!text) return "text invalide";
  if (o.mode !== undefined && o.mode !== "voix" && o.mode !== "info") return "mode invalide";
  const mode: Mode = o.mode === "voix" ? "voix" : "info";
  let key: string | undefined;
  if (o.key !== undefined) {
    if (typeof o.key !== "string" || !o.key || o.key.length > MAX_KEY) return "key invalide";
    key = o.key;
  }
  let action: Message["action"];
  if (o.action !== undefined) {
    const a = obj(o.action);
    if (!a) return "action invalide";
    const label = cleanText(a.label, MAX_LABEL);
    if (!label) return "action.label invalide";
    const url = checkActionUrl(a.url, schemes);
    if (typeof url !== "string") return `action.url : ${url.error}`;
    action = { label, url };
  }
  return { app: o.app, text, mode, ...(key ? { key } : {}), ...(action ? { action } : {}) };
}
