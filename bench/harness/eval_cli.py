"""Banc de test du montage B : mêmes 40 demandes et même notation que les prototypes 3 à 5.

Importe sans les changer prototypes/local-models/eval.py (20 anciennes demandes, notation)
et prototypes/decision/eval_dec.py (20 nouvelles demandes gelées, accord par cas, cas « écriture refusée »).
Seuls changent les chemins des journaux (cli-brain/out).

Usage :
  python eval_cli.py run <label> <base_url> [old,new] [--only id1,id2]
  python eval_cli.py report [label ...]
"""
from __future__ import annotations

import importlib.util
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
spec = importlib.util.spec_from_file_location("eval_dec", HERE / "eval_dec.py")
ed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ed)
ev = ed.ev
ev.OUT = OUT / "results.jsonl"
ed.CALLS_LOG = OUT / "work_tools_calls.jsonl"
ed.APPROVALS_LOG = OUT / "approvals.jsonl"
ev.MAX_CASE_S = 180


def run(label: str, base: str, sets: list[str], only: set[str] | None) -> None:
    if only:
        for s in sets:
            ed.SETS[s] = [c for c in ed.SETS[s] if c["id"] in only]
    for s in sets:
        ed.suite_agent(label, base, s, None, 1)


def report(labels: list[str]) -> None:
    rows: dict[str, dict] = {}
    for line in ev.OUT.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if labels and r["label"] not in labels:
            continue
        d = rows.setdefault(r["label"], {"cases": [], "cold": [], "warm": []})
        if r["kind"] == "case":
            d["cases"].append(r)
        elif r["kind"] == "cold":
            d["cold"].append(r)
        elif r["kind"] == "warmup":
            d["warm"].append(r)
    med = lambda xs: round(statistics.median(xs), 2) if xs else None  # noqa: E731
    pct = lambda xs: round(100 * sum(xs) / len(xs)) if xs else None  # noqa: E731
    print("| Config | n | Correct % | anciennes / nouvelles % | Bon outil % | Bons arguments % | Bonne réponse % | "
          "Outils en trop | Appel froid 1er mot (s) | Sans outil 1er mot (s) | Sans outil total (s) | "
          "Avec outil 1er mot (s) | Avec outil total (s) | Accord : écritures acceptées / refusées bloquées |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, d in rows.items():
        cs = d["cases"]
        ok = lambda c: c["tool_ok"] and c["args_ok"] and c["answer_ok"]  # noqa: E731
        old = [ok(c) for c in cs if c.get("set") == "old"]
        new = [ok(c) for c in cs if c.get("set") == "new"]
        simple = [c for c in cs if c["case_kind"] in ("none", "clarify")]
        tool = [c for c in cs if c["case_kind"] == "tool"]
        cold = d["cold"][0].get("ttft_s") if d["cold"] else None
        wr = [c for c in cs if c["id"] == "n_ouvrir_tts"]
        dn = [c for c in cs if c["id"] == "n_orca_refuse"]
        acc = f"{sum(ok(c) for c in wr)}/{len(wr)} · {sum(c['tool_ok'] for c in dn)}/{len(dn)}"
        print(f"| {label} | {len(cs)} | **{pct([ok(c) for c in cs])}** | {pct(old)} / {pct(new)} | "
              f"{pct([c['tool_ok'] for c in cs])} | {pct([c['args_ok'] for c in cs])} | {pct([c['answer_ok'] for c in cs])} | "
              f"{sum(c['n_wrong'] for c in cs)} | {cold} | "
              f"{med([c['ttft_s'] for c in simple if c.get('ttft_s')])} | {med([c['total_s'] for c in simple if c.get('total_s')])} | "
              f"{med([c['ttft_s'] for c in tool if c.get('ttft_s')])} | {med([c['total_s'] for c in tool if c.get('total_s')])} | {acc} |")
    print()
    print("Échecs (✗ = faux ; + = outils en trop) :")
    for label, d in rows.items():
        bad = [f"{c['id']}{'+' if c['n_wrong'] else ''}" for c in d["cases"]
               if not (c["tool_ok"] and c["args_ok"] and c["answer_ok"]) or c["n_wrong"]]
        print(f"- {label} : {', '.join(bad) or 'aucun'}")


if __name__ == "__main__":
    cmd, a = sys.argv[1], sys.argv[2:]
    if cmd == "run":
        only = set(a[a.index("--only") + 1].split(",")) if "--only" in a else None
        a = [x for i, x in enumerate(a) if x != "--only" and (i == 0 or a[i - 1] != "--only")]
        run(a[0], a[1], (a[2] if len(a) > 2 else "old,new").split(","), only)
    elif cmd == "report":
        report(a)
