// Dictée : tape du texte dans la fenêtre active, comme un clavier (Windows, SendInput).
// - Les caractères sont envoyés en Unicode (accents compris), pas par le presse-papiers :
//   l'application voit une frappe normale (pas de « texte collé » replié), et le presse-papiers reste intact.
// - Jamais de touche Entrée : un retour à la ligne devient une espace (sinon un message partirait).
// - Une correction (Retour arrière) n'est faite que dans la fenêtre où le texte a été tapé.
// - On attend que Ctrl/Alt/Maj/Windows soient relâchés : sinon « a » deviendrait Ctrl+A.
import { createRequire } from "node:module";
import type * as Koffi from "koffi";

const require = createRequire(import.meta.url);

const VK_BACK = 0x08;
const KEYEVENTF_KEYUP = 0x2;
const KEYEVENTF_UNICODE = 0x4;
const MODIFIERS = [0x10, 0x11, 0x12, 0x5b, 0x5c]; // Maj, Ctrl, Alt, Windows gauche et droite

/** Un bloc de saisie clavier (structure INPUT de Windows, remplie par koffi). */
interface Input { type: number; ki: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number }; pad: number[] }
interface Win32 {
  SendInput(count: number, inputs: Input[], size: number): number;
  GetForegroundWindow(): number | bigint;
  GetAsyncKeyState(vk: number): number;
  GetWindowRect(hwnd: number | bigint, rect: Record<string, number>): boolean;
  size: number;
}
export interface Rect { x: number; y: number; width: number; height: number }

let api: Win32 | null = null;
function load(): Win32 {
  if (api) return api;
  if (process.platform !== "win32") throw Object.assign(new Error("la dictée ne tape le texte que sous Windows pour l'instant"), { text: { fr: "la dictée ne tape le texte que sous Windows pour l'instant", en: "dictation only types text on Windows for now" } });
  const koffi: typeof Koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr" });
  // INPUT : type + union (MOUSEINPUT, la plus grande, fait 32 octets) ; KEYBDINPUT (24 octets) est complété.
  koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
  const INPUT = koffi.struct("INPUT", { type: "uint32", ki: KEYBDINPUT, pad: koffi.array("uint8", 8) });
  // koffi type ses fonctions de façon générique : on les décrit ici telles qu'elles sont déclarées juste au-dessus.
  api = {
    SendInput: user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)"),
    GetForegroundWindow: user32.func("uintptr __stdcall GetForegroundWindow()"),
    GetAsyncKeyState: user32.func("int16 __stdcall GetAsyncKeyState(int vKey)"),
    GetWindowRect: user32.func("bool __stdcall GetWindowRect(uintptr hWnd, _Out_ RECT *lpRect)"),
    size: koffi.sizeof(INPUT),
  };
  return api;
}

const key = (vk: number, scan: number, flags: number): Input => ({ type: 1, ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 }, pad: [0, 0, 0, 0, 0, 0, 0, 0] });

function send(inputs: Input[]): void {
  const a = load();
  for (let i = 0; i < inputs.length; i += 200) {
    const part = inputs.slice(i, i + 200);
    if (a.SendInput(part.length, part, a.size) !== part.length) throw new Error("Windows a refusé la frappe (fenêtre d'un programme lancé en administrateur ?)");
  }
}

/** Les caractères d'un texte, en frappes Unicode (une paire de touches par unité UTF-16). */
function textInputs(text: string): Input[] {
  const out: Input[] = [];
  for (const ch of text.replace(/[\r\n]+/g, " ")) {
    for (let i = 0; i < ch.length; i++) {
      const code = ch.charCodeAt(i);
      out.push(key(0, code, KEYEVENTF_UNICODE), key(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
  }
  return out;
}

/** Nombre de frappes Retour arrière pour effacer `n` caractères (un emoji compte pour un). */
const backspaces = (n: number): Input[] => Array.from({ length: n }, () => [key(VK_BACK, 0, 0), key(VK_BACK, 0, KEYEVENTF_KEYUP)]).flat();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rectangle de la fenêtre active, en pixels physiques ({x, y, width, height}), ou null. */
export function foregroundRect(): Rect | null {
  const a = load();
  const hwnd = a.GetForegroundWindow();
  if (!hwnd) return null;
  const r: Record<string, number> = {};
  if (!a.GetWindowRect(hwnd, r)) return null;
  return { x: r.left!, y: r.top!, width: r.right! - r.left!, height: r.bottom! - r.top! };
}

export class Typer {
  private queue: Promise<void> = Promise.resolve();
  private window = 0n; // fenêtre où la dictée a tapé en dernier

  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = () => {}) {
    this.log = log;
  }

  /** Une nouvelle dictée : la fenêtre de référence sera celle du premier mot. */
  reset() { this.window = 0n; }

  /** Effacer `del` caractères puis taper `ins`. Les frappes passent dans l'ordre, l'une après l'autre. */
  edit(del: number, ins: string): Promise<void> {
    this.queue = this.queue.then(() => this.run(del, ins)).catch((e) => this.log(`dictée : ${(e as Error)?.message ?? e}`));
    return this.queue;
  }

  private async run(del: number, ins: string): Promise<void> {
    const a = load();
    // Le raccourci vient d'être pressé : attendre que les touches de modification soient relâchées (5 s au plus).
    for (let t = 0; t < 200 && MODIFIERS.some((vk) => a.GetAsyncKeyState(vk) < 0); t++) await sleep(25);
    const fg = BigInt(a.GetForegroundWindow());
    if (del > 0) {
      // Correction : seulement dans la même fenêtre, sinon on effacerait le texte d'une autre application.
      if (this.window && fg !== this.window) { this.log("dictée : fenêtre changée, correction abandonnée"); return; }
      send(backspaces(del));
    }
    if (ins) send(textInputs(ins));
    this.window = fg;
  }
}
