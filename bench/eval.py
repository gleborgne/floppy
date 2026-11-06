"""Banc du cerveau du noyau : mêmes 40 demandes et même notation que les prototypes 3 à 5.

Notation : bench/harness/ (repris des prototypes : eval_cli.py → eval_dec.py → eval_base.py, demandes dans cases_new.py).
Les journaux vont dans bench/out.

  python bench/eval.py run <label> [http://127.0.0.1:8751/v1] [old,new] [--only id1,id2]
  python bench/eval.py report [label ...]
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

spec = importlib.util.spec_from_file_location("eval_cli", HERE / "harness" / "eval_cli.py")
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)
ec.ev.OUT = OUT / "results.jsonl"
ec.ed.CALLS_LOG = OUT / "work_tools_calls.jsonl"
ec.ed.APPROVALS_LOG = OUT / "approvals.jsonl"

if __name__ == "__main__":
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "run":
        only = set(a[a.index("--only") + 1].split(",")) if "--only" in a else None
        pos = [x for x in a if not x.startswith("--") and (a.index(x) == 0 or a[a.index(x) - 1] != "--only")]
        label = pos[0]
        base = pos[1] if len(pos) > 1 else "http://127.0.0.1:8751/v1"
        sets = (pos[2] if len(pos) > 2 else "old,new").split(",")
        ec.run(label, base, sets, only)
    elif cmd == "report":
        ec.report(a)
