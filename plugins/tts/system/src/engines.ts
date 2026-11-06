// Les trois moteurs de voix du système : WinRT (Windows), `say` (macOS), espeak-ng (Linux).
// Chacun liste ses voix et transforme une phrase en WAV. Les lecteurs de sortie sont purs (testés sans le système).
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POWERSHELL_ARGS, PowerShellHelper, b64 } from "./windows.ts";

export type Spawn = (command: string, args: string[], options?: SpawnOptions) => ChildProcess;

/** Une voix installée sur la machine. `id` est ce que le moteur attend ; `lang` au format « fr-FR ». */
export interface SystemVoice { id: string; name: string; lang: string; gender?: string }

/** Un moteur qui parle, ouvert pour une voix en service. */
export interface Speaker {
  /** Une phrase -> le fichier WAV complet. */
  synth(voice: string, text: string, signal: AbortSignal): Promise<Uint8Array>;
  close(): void;
}

export interface Engine {
  /** Moteur, pour les journaux seulement (l'utilisateur ne voit pas le nom du système). */
  label: string;
  /** Programme dont dépend le moteur (journaux). */
  missing: string;
  voices(spawn: Spawn): Promise<SystemVoice[]>;
  open(spawn: Spawn): Speaker;
}

/** Lance un programme, lui donne `input`, attend la fin et rend sa sortie. */
export function run(spawn: Spawn, cmd: string, args: string[], opts: { input?: string; signal?: AbortSignal } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { reject(e); return; }
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-500); });
    const onAbort = () => { child.kill(); reject(opts.signal!.reason); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { opts.signal?.removeEventListener("abort", onAbort); reject(e); });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} : code ${code}${err ? ` : ${err.trim()}` : ""}`));
    });
    child.stdin!.end(opts.input ?? "");
  });
}

// ---- Windows

export const windows: Engine = {
  label: "Windows (WinRT)",
  missing: "powershell.exe",
  async voices(spawn) {
    const h = new PowerShellHelper(() => spawn("powershell.exe", POWERSHELL_ARGS, { stdio: ["pipe", "pipe", "pipe"] }));
    try { return parseWindowsVoices((await h.request("VOICES")).toString("utf8")); } finally { h.close(); }
  },
  open(spawn) {
    const h = new PowerShellHelper(() => spawn("powershell.exe", POWERSHELL_ARGS, { stdio: ["pipe", "pipe", "pipe"] }));
    h.warm();
    return {
      async synth(voice, text, signal) { return h.request(`SPEAK ${b64(voice)} ${b64(text)}`, signal); },
      close: () => h.close(),
    };
  },
};

export function parseWindowsVoices(json: string): SystemVoice[] {
  const raw = JSON.parse(json) as unknown;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((v) => {
    const x = v as Partial<SystemVoice>;
    return typeof x.id === "string" && typeof x.name === "string"
      ? [{ id: x.id, name: x.name, lang: x.lang ?? "", ...(x.gender ? { gender: x.gender } : {}) }]
      : [];
  });
}

// ---- macOS

export const macos: Engine = {
  label: "macOS (say)",
  missing: "say",
  async voices(spawn) { return parseSayVoices((await run(spawn, "say", ["-v", "?"])).toString("utf8")); },
  open(spawn) {
    return {
      async synth(voice, text, signal) {
        // `say` n'écrit pas de WAV sur sa sortie : on passe par un dossier temporaire.
        const dir = mkdtempSync(join(tmpdir(), "floppy-say-"));
        try {
          const input = join(dir, "texte.txt");
          const output = join(dir, "voix.wav");
          writeFileSync(input, text, "utf8");
          await run(spawn, "say", ["-v", voice, "-o", output, "--file-format=WAVE", "--data-format=LEI16@22050", "-f", input], { signal });
          return readFileSync(output);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      },
      close() {},
    };
  },
};

/** Lignes de `say -v ?` : « Amélie (Enhanced)   fr_CA    # Bonjour… ». Le nom peut contenir des espaces. */
export function parseSayVoices(text: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#/.exec(line);
    if (m) out.push({ id: m[1]!.trim(), name: m[1]!.trim(), lang: m[2]!.replace("_", "-") });
  }
  return out;
}

// ---- Linux

export const linux: Engine = {
  label: "Linux (espeak-ng)",
  missing: "espeak-ng",
  async voices(spawn) { return parseEspeakVoices((await run(spawn, "espeak-ng", ["--voices"])).toString("utf8")); },
  open(spawn) {
    return {
      async synth(voice, text, signal) { return run(spawn, "espeak-ng", ["-v", voice, "--stdout", "--stdin"], { input: text, signal }); },
      close() {},
    };
  },
};

/** Tableau de `espeak-ng --voices` : « Pty Language Age/Gender VoiceName File Other ». Une voix par langue. */
export function parseEspeakVoices(text: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [, lang, ageGender, name] = line.trim().split(/\s+/);
    if (!lang || !name || seen.has(lang)) continue;
    seen.add(lang);
    const g = ageGender?.split("/")[1];
    out.push({ id: lang, name: name.replace(/_/g, " "), lang, ...(g === "M" ? { gender: "Male" } : g === "F" ? { gender: "Female" } : {}) });
  }
  return out;
}

export function engineFor(platform: NodeJS.Platform): Engine | undefined {
  return platform === "win32" ? windows : platform === "darwin" ? macos : platform === "linux" ? linux : undefined;
}
