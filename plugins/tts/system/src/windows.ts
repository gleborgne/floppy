// Aide Windows : un PowerShell 5.1 (powershell.exe, pas pwsh : lui seul charge les types WinRT) gardé ouvert.
// Il parle avec les voix OneCore de WinRT (Windows.Media.SpeechSynthesis), plus nombreuses que celles de SAPI.
// Protocole, une ligne par commande et par réponse, tout le texte en base64 UTF-8 (pas de souci d'encodage console) :
//   VOICES                    -> OK <base64 JSON [{id,name,lang,gender}]>
//   SPEAK <voix64> <texte64>  -> OK <base64 du WAV>
//   erreur                    -> ERR <base64 du message>
import type { ChildProcess } from "node:child_process";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
} | Select-Object -First 1
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(-1)
  $task.Result
}
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function Text([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
function Short([string]$id) { $id.Substring($id.LastIndexOf('\') + 1) }
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$out = [Console]::Out
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $parts = $line.Split(' ')
    if ($parts[0] -eq 'VOICES') {
      $list = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
        [ordered]@{ id = (Short $_.Id); name = $_.DisplayName; lang = $_.Language; gender = "$($_.Gender)" }
      })
      $out.WriteLine('OK ' + (B64 (ConvertTo-Json -InputObject $list -Compress)))
    } elseif ($parts[0] -eq 'SPEAK' -and $parts.Count -eq 3) {
      $want = Text $parts[1]
      $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { (Short $_.Id) -eq $want } | Select-Object -First 1
      if ($null -eq $voice) { throw "voix introuvable : $want" }
      $synth.Voice = $voice
      $stream = Wait-Op ($synth.SynthesizeTextToStreamAsync((Text $parts[2]))) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
      $read = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
      $mem = New-Object System.IO.MemoryStream
      $read.CopyTo($mem)
      $stream.Dispose()
      $out.WriteLine('OK ' + [Convert]::ToBase64String($mem.ToArray()))
    } else { throw 'commande inconnue' }
  } catch { $out.WriteLine('ERR ' + (B64 $_.Exception.Message)) }
  $out.Flush()
}
`;

export const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")];

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

type Waiter = { resolve(data: Buffer): void; reject(err: Error): void };

/** Le PowerShell gardé ouvert. Les réponses arrivent dans l'ordre des demandes : une file d'attente suffit. */
export class PowerShellHelper {
  private child?: ChildProcess;
  private waiters: Waiter[] = [];
  private buffer = "";

  private readonly launch: () => ChildProcess;

  constructor(launch: () => ChildProcess) { this.launch = launch; }

  /** Lance PowerShell tout de suite (il met environ une seconde à démarrer). */
  warm(): void { this.ensure(); }

  request(line: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const child = this.ensure();
    return new Promise<Buffer>((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      this.waiters.push(w);
      // Abandon : on rend la main tout de suite ; la réponse, quand elle arrivera, sera jetée.
      signal?.addEventListener("abort", () => { w.resolve = () => {}; w.reject = () => {}; reject(signal.reason); }, { once: true });
      child.stdin!.write(line + "\n");
    });
  }

  close(): void {
    const c = this.child;
    this.child = undefined;
    c?.stdin?.end();
    this.failAll(new Error("voix du système arrêtée"));
  }

  private ensure(): ChildProcess {
    if (this.child) return this.child;
    const child = this.launch();
    this.child = child;
    this.buffer = "";
    child.stdout!.setEncoding("ascii");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.answer(line);
      }
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-500); });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failAll(new Error(`PowerShell s'est arrêté (${why})${stderr ? ` : ${stderr.trim()}` : ""}`));
    };
    child.on("error", (e) => gone(e.message));
    child.on("exit", (code) => gone(`code ${code}`));
    return child;
  }

  private answer(line: string): void {
    const w = this.waiters.shift();
    if (!w) return;
    const [kind, data = ""] = line.split(" ");
    if (kind === "OK") w.resolve(Buffer.from(data, "base64"));
    else w.reject(new Error(Buffer.from(data, "base64").toString("utf8") || "erreur PowerShell"));
  }

  private failAll(err: Error): void {
    const all = this.waiters;
    this.waiters = [];
    for (const w of all) w.reject(err);
  }
}
