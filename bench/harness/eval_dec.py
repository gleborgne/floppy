"""Évaluation du prototype « décision » : mêmes règles de notation que prototypes/local-models/eval.py (importé tel quel).

Ajouts :
  - jeu « old » (les 20 demandes du prototype 3) ou « new » (cases_new.py, 20 nouvelles demandes gelées) ;
  - politique d'accord par cas (en-tête X-Approval : auto / deny) ;
  - cas « denied » : l'accord doit être demandé, l'écriture ne doit pas avoir lieu, la réponse doit le dire.

Usage :
  python eval_dec.py agent <label> <agent_base_url> <old|new> [--llama URL] [--run N]
  python eval_dec.py report
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "out"
spec = importlib.util.spec_from_file_location("p3eval", HERE / "eval_base.py")
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)
ev.OUT = OUT_DIR / "results.jsonl"
sys.path.insert(0, str(HERE))
from cases_new import CASES_NEW  # noqa: E402

CALLS_LOG = OUT_DIR / "work_tools_calls.jsonl"
APPROVALS_LOG = OUT_DIR / "approvals.jsonl"
WRITE_TOOLS = {"ouvrir_url", "orca_confier_tache"}
SETS = {"old": ev.CASES, "new": CASES_NEW}

# --- politique d'accord par requête : on ajoute l'en-tête au Request construit par ev.ask
_APPROVAL = {"policy": "auto"}


class _Req(urllib.request.Request):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.add_header("X-Approval", _APPROVAL["policy"])


ev.urllib.request.Request = _Req


def read_approvals(start: int) -> tuple[list[dict], int]:
    if not APPROVALS_LOG.exists():
        return [], start
    data = APPROVALS_LOG.read_bytes()
    return [json.loads(x) for x in data[start:].decode("utf-8").splitlines() if x.strip()], len(data)


def score(case: dict, res: dict, calls: list[dict], approvals: list[dict]) -> dict:
    """Notation de eval.py ; pour « denied », on lit la demande d'accord au lieu de l'appel MCP."""
    if case["kind"] != "denied":
        sc = ev.score(case, res, calls)
    else:
        sc = ev.score({**case, "kind": "tool"}, res, calls)   # pour outils en trop, FR, court
        asked = [a for a in approvals if a["tool"] in case["need"]]
        executed = [c for c in calls if c["tool"] in WRITE_TOOLS]
        args_ok = any(all(re.search(rx, ev.norm(str((a.get("args") or {}).get(arg) or "")))
                          for arg, rx in case["args"][case["need"][0]].items()) for a in asked)
        text_n = ev.norm(res["text"])
        sc.update(tool_ok=bool(asked) and not executed, args_ok=bool(asked) and args_ok and not executed,
                  answer_ok=bool(res["text"]) and all(re.search(k, text_n) for k in case["keys"]),
                  executed_writes=[c["tool"] for c in executed])
    sc["approvals"] = approvals
    return sc


def suite_agent(label: str, base: str, set_name: str, llama: str | None, run: int) -> None:
    cases = SETS[set_name]
    pos = CALLS_LOG.stat().st_size if CALLS_LOG.exists() else 0
    apos = APPROVALS_LOG.stat().st_size if APPROVALS_LOG.exists() else 0
    for kind in ("cold", "warmup"):
        idle = ev.wait_idle(llama)
        try:
            res = ev.ask(base, "none", ev.WARMUP)
        except Exception as e:  # noqa: BLE001
            res = {"error": f"{type(e).__name__}: {e}"[:300]}
        _, pos = ev.read_calls(CALLS_LOG, pos)
        _, apos = read_approvals(apos)
        rec = {"label": label, "set": set_name, "run": run, "kind": kind, "idle_wait_s": idle, **res}
        ev.write(rec)
        print(json.dumps({k: rec.get(k) for k in ("label", "kind", "ttft_s", "total_s", "error")}, ensure_ascii=False), flush=True)
    for case in cases:
        idle = ev.wait_idle(llama)
        _APPROVAL["policy"] = case.get("approval", "auto")
        try:
            res, err = ev.ask(base, "none", case["prompt"]), None
        except Exception as e:  # noqa: BLE001
            res, err = {"ttft_s": None, "total_s": None, "hermes_tools": [], "text": ""}, f"{type(e).__name__}: {e}"[:300]
        time.sleep(0.5)
        calls, pos = ev.read_calls(CALLS_LOG, pos)
        approvals, apos = read_approvals(apos)
        sc = score(case, res, calls, approvals)
        rec = {"label": label, "set": set_name, "run": run, "kind": "case", "id": case["id"], "case_kind": case["kind"],
               "prompt": case["prompt"], "idle_wait_s": idle, **res, **sc, "error": err}
        ev.write(rec)
        print(f"{label} {case['id']:22s} tool={sc['tool_ok']!s:5} args={sc['args_ok']!s:5} ans={sc['answer_ok']!s:5} "
              f"wrong={sc['wrong_tools']} ttft={res.get('ttft_s')} tot={res.get('total_s')} | {res['text'][:90]!r}", flush=True)


if __name__ == "__main__":
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "agent":
        llama = a[a.index("--llama") + 1] if "--llama" in a else None
        run = int(a[a.index("--run") + 1]) if "--run" in a else 1
        suite_agent(a[0], a[1], a[2], llama, run)
