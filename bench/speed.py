"""Banc de vitesse d'un modèle llama.cpp : lecture (prefill) et écriture avec ou sans MTP.

Lance llama-server pour chaque configuration (port 8093), mesure, puis l'arrête.
  python -I bench/speed.py <gguf> <sortie.jsonl> [--exe <llama-server>] [--only prefill|mtp|ctx]

Mesures :
- prefill : -ub {512,1024,2048,4096} x --n-cpu-moe {26,20,14} sur ~13 000 jetons ; mémoire GPU au repos et en pointe.
- mtp : sans MTP puis --spec-type draft-mtp avec --spec-draft-n-max {1,2,3,4} ; vitesse d'écriture et part des
  jetons proposés acceptés, sur 3 demandes (réponse en français, appel d'outil, résumé).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

PORT = 8093
BASE = f"http://127.0.0.1:{PORT}"
COMMON = ["--jinja", "--host", "127.0.0.1", "--port", str(PORT), "--no-webui", "-fa", "on",
          "-ctk", "q8_0", "-ctv", "q8_0", "-np", "1", "--fit", "off", "-ngl", "99", "--reasoning", "on"]
NOTHINK = {"chat_template_kwargs": {"enable_thinking": False}, "thinking_budget_tokens": 0}

LONG = " ".join(["Le projet Floppy est un assistant vocal local qui tourne sur un PC Windows avec une carte graphique, "
                 "il lit les mails, l'agenda, les tickets Azure DevOps et les notes Obsidian de l'utilisateur."] * 330)
TOOLS = [{"type": "function", "function": {"name": "lister_work_items", "description": "Liste les work items Azure DevOps d'un projet.",
          "parameters": {"type": "object", "properties": {"projet": {"type": "string"}, "etat": {"type": "string", "enum": ["actif", "fermé", "tous"]}}, "required": ["projet"]}}}]
GEN = [
    ("francais", {"messages": [{"role": "user", "content": "Explique en un paragraphe de six phrases, en français simple, la différence entre un merge et un rebase dans git."}], "max_tokens": 300}),
    ("outil", {"messages": [{"role": "system", "content": "Tu es Floppy. Appelle l'outil adapté sans rien dire avant."},
                            {"role": "user", "content": "Quels sont mes work items actifs dans le projet Floppy ?"}], "tools": TOOLS, "max_tokens": 120}),
    ("resume", {"messages": [{"role": "user", "content": "Voici une note de réunion : la mise en production de Floppy est prévue jeudi, "
                                                          "Sophie relit la PR 42, les tests e2e Safari échouent depuis lundi, Marc corrige le build develop. "
                                                          "Fais un résumé en cinq puces courtes, en français."}], "max_tokens": 250}),
]


def post(path: str, body: dict, timeout: float = 300) -> dict:
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def healthy() -> bool:
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def vram_mib() -> int:
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    return int(out.strip().splitlines()[0])


class Peak:
    def __init__(self):
        self.peak = 0
        self.stop = False
        self.t = threading.Thread(target=self.run, daemon=True)
        self.t.start()

    def run(self):
        while not self.stop:
            try:
                self.peak = max(self.peak, vram_mib())
            except Exception:
                pass
            time.sleep(0.3)


def with_server(exe: str, model: str, extra: list[str], fn) -> dict:
    base = vram_mib()
    ctx = [] if "-c" in extra else ["-c", "32768"]
    p = subprocess.Popen([exe, "-m", model, *COMMON, *ctx, *extra], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    tail: list[str] = []
    threading.Thread(target=lambda: [tail.append(l) or tail.__setitem__(slice(0, -20), []) for l in p.stderr], daemon=True).start()
    try:
        t0 = time.time()
        while not healthy():
            if p.poll() is not None:
                return {"error": "arrêt au chargement", "log": "".join(tail[-5:])}
            if time.time() - t0 > 300:
                return {"error": "pas prêt après 300 s"}
            time.sleep(0.5)
        peak = Peak()
        loaded = vram_mib()
        try:
            r = fn()
        finally:
            peak.stop = True
        r.update(vram_base_mib=base, vram_loaded_mib=loaded, vram_peak_mib=peak.peak, vram_free_peak_mib=24570 - peak.peak)
        return r
    except Exception as e:  # noqa: BLE001
        return {"error": str(e), "log": "".join(tail[-5:])}
    finally:
        p.terminate()
        try:
            p.wait(30)
        except subprocess.TimeoutExpired:
            p.kill()
        for _ in range(60):
            if not healthy():
                break
            time.sleep(0.5)
        time.sleep(2)


def prefill_case() -> dict:
    post("/v1/chat/completions", {"messages": [{"role": "user", "content": "Bonjour."}], "max_tokens": 4, **NOTHINK})  # chauffe
    runs = []
    for i in range(2):
        # Un caractère différent au début : pas de réutilisation du cache entre les deux passes.
        r = post("/v1/chat/completions", {"messages": [{"role": "user", "content": f"[{i}] {LONG} Résume en une phrase."}], "max_tokens": 16, "cache_prompt": False, **NOTHINK})
        t = r["timings"]
        runs.append({"prompt_n": t["prompt_n"], "pp_tok_s": round(t["prompt_per_second"]), "tg_tok_s": round(t["predicted_per_second"], 1)})
    return {"runs": runs, "pp_tok_s": max(x["pp_tok_s"] for x in runs), "prompt_n": runs[-1]["prompt_n"]}


def gen_case() -> dict:
    post("/v1/chat/completions", {"messages": [{"role": "user", "content": "Bonjour."}], "max_tokens": 8, **NOTHINK})
    out = {}
    for name, body in GEN:
        r = post("/v1/chat/completions", {**body, "temperature": 0.3, **NOTHINK})
        t = r["timings"]
        d = t.get("draft_n") or 0
        a = t.get("draft_n_accepted") or 0
        out[name] = {"tg_tok_s": round(t["predicted_per_second"], 1), "tokens": t["predicted_n"],
                     "draft_n": d, "accepted": a, "accept_pct": round(100 * a / d) if d else None,
                     "tool_ok": bool(r["choices"][0]["message"].get("tool_calls")) if name == "outil" else None}
    return out


def main() -> None:
    model, outp = sys.argv[1], Path(sys.argv[2])
    exe = sys.argv[sys.argv.index("--exe") + 1] if "--exe" in sys.argv else (shutil.which("llama-server") or "llama-server")
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    outp.parent.mkdir(parents=True, exist_ok=True)

    def save(row: dict) -> None:
        print(json.dumps(row, ensure_ascii=False), flush=True)
        with outp.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    if only in (None, "prefill"):
        for moe in (26, 20, 14):
            for ub in (512, 1024, 2048, 4096):
                r = with_server(exe, model, ["--n-cpu-moe", str(moe), "-ub", str(ub), "-b", str(max(ub, 2048))], prefill_case)
                save({"kind": "prefill", "n_cpu_moe": moe, "ub": ub, **r})
    if only in (None, "mtp"):
        for n in (0, 1, 2, 3, 4):
            spec = [] if n == 0 else ["--spec-type", "draft-mtp", "--spec-draft-n-max", str(n)]
            r = with_server(exe, model, ["--n-cpu-moe", "26", "-ub", "2048", "-b", "2048", *spec], gen_case)
            save({"kind": "mtp", "draft_n_max": n, **r})
    if only in (None, "ctx"):
        # Mémoire GPU selon le contexte (MTP actif) : ce qui reste pour la voix.
        for c in (32768, 65536, 131072):
            r = with_server(exe, model, ["-c", str(c), "--n-cpu-moe", "26", "-ub", "2048", "-b", "2048", "--spec-type", "draft-mtp"], prefill_case)
            save({"kind": "ctx", "ctx": c, **r})


if __name__ == "__main__":
    main()
