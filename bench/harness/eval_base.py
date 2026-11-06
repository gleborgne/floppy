"""Prototype n°3 : évaluation d'un LLM comme orchestrateur dans Hermes (API locale, outils normaux).

Usage :
  python eval.py suite <label> <hermes_base_url> <api_key> <calls_log> [--runs N] [--only id1,id2]
  python eval.py speed <label> <llama_base_url>        # vitesse brute du llama-server (pp et tg en tokens/s)
  python eval.py report                                # tableau récapitulatif depuis out/results.jsonl

Chaque cas : une requête streaming /v1/chat/completions vers Hermes, nouvelle session à chaque fois.
On mesure : TTFT (premier mot de la réponse), temps total, appels d'outils (événements hermes.tool.progress),
et on lit le journal du faux serveur MCP work_tools pour connaître les arguments exacts.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "results.jsonl"
BRIDGE_TOOLS = {"tool_search", "tool_describe", "tool_call"}   # recherche d'outils différée de Hermes


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn").replace("’", "'")


# ------------------------------------------------------------------ cas de test
# need    : outils work_tools obligatoires (tous)
# allow   : outils work_tools tolérés en plus
# args    : {outil: {argument: regex}} (au moins un appel de l'outil doit correspondre)
# keys    : groupes de mots (regex) ; chaque groupe doit apparaître dans la réponse
# kind    : tool | none (pas d'outil) | clarify (question courte attendue, pas d'outil de travail)
CASES = [
    dict(id="agenda", prompt="Floppy, qu'est-ce que j'ai aujourd'hui ?", kind="tool",
         need=["agenda_du_jour"], allow=["prochain_rdv"],
         keys=[r"daily|architecture|dentiste|hexa|dubois"]),
    dict(id="prochain_rdv", prompt="C'est quoi mon prochain rendez-vous ?", kind="tool",
         need=["prochain_rdv|agenda_du_jour"], keys=[r"architecture", r"11"]),
    dict(id="mails", prompt="J'ai des nouveaux mails ?", kind="tool",
         need=["mails_non_lus"], keys=[r"sophie|facture|entretien|azure|quatre|\b4\b"]),
    dict(id="pr", prompt="J'ai des PR à relire ?", kind="tool",
         need=["mes_pr_a_relire"], keys=[r"redis|482", r"vite|479"]),
    dict(id="build_master", prompt="Le build de master est passé ?", kind="tool",
         need=["etat_build"], args={"etat_build": {"pipeline": r"master|main"}},
         keys=[r"echou|echec|rouge|casse|plante|non\b|pas passe|n'est pas"]),
    dict(id="build_develop", prompt="Et le build develop, il est vert ?", kind="tool",
         need=["etat_build"], args={"etat_build": {"pipeline": r"develop"}},
         keys=[r"reussi|vert|passe|succes|oui"]),
    dict(id="tickets_en_cours", prompt="Quels tickets j'ai en cours ?", kind="tool",
         need=["mes_tickets"], args={"mes_tickets": {"etat": r"en cours|^$|none"}},
         keys=[r"safari|login|connexion|1201"]),
    dict(id="tickets_a_faire", prompt="J'ai quoi comme tickets à faire ?", kind="tool",
         need=["mes_tickets"], args={"mes_tickets": {"etat": r"a faire|^$|none"}},
         keys=[r"csv|1187", r"doc|1210"]),
    dict(id="note_deploiement", prompt="Dans mes notes, comment on déploie le front ?", kind="tool",
         need=["chercher_notes"], allow=["lire_note"], args={"chercher_notes": {"requete": r"deplo|front"}},
         keys=[r"build|upload|blob|stockage|storage|cdn"]),
    dict(id="note_architecture", prompt="Lis-moi ma note sur l'architecture d'Ariane.", kind="tool",
         need=["lire_note|chercher_notes"], allow=["chercher_notes", "lire_note"],
         keys=[r"postgre|react|\.net|entra|redis"]),
    dict(id="ouvrir_turn", prompt="Ouvre le site sur les turn detectors que j'ai noté.", kind="tool",
         need=["chercher_notes", "ouvrir_url"], allow=["lire_note"],
         args={"ouvrir_url": {"url": r"^https://veille\.example\.com/voix/turn-detectors-2026/?$"}},
         keys=[r"ouv|voila|c'est fait|navigateur"]),
    dict(id="orca_etat", prompt="Où en sont mes agents ?", kind="tool",
         need=["orca_etat_agents"], keys=[r"paiement|70", r"bloqu|accord|migration"]),
    dict(id="orca_confier", prompt="Confie à Orca la correction du bug de login dans le projet ariane.", kind="tool",
         need=["orca_confier_tache"], args={"orca_confier_tache": {"projet": r"ariane", "tache": r"login|connexion"}},
         keys=[r"t-57|confi|cree|lance|transmis|c'est fait|assign"]),
    dict(id="multi_matin", prompt="Fais-moi le point de la journée : mes rendez-vous et mes mails non lus.", kind="tool",
         need=["agenda_du_jour", "mails_non_lus"], allow=["prochain_rdv"],
         keys=[r"daily|architecture|dentiste|hexa", r"sophie|facture|entretien|azure|mail"]),
    dict(id="agenda_demain", prompt="Qu'est-ce que j'ai demain ?", kind="tool",
         need=["agenda_du_jour"], args={"agenda_du_jour": {"date": r"2026-11-05|demain|05/11|5 nov"}},
         keys=[r"atelier|ux", r"entretien|paul"]),
    dict(id="chat_salut", prompt="Salut Floppy, ça va ?", kind="none", keys=[]),
    dict(id="savoir_capitale", prompt="Quelle est la capitale de l'Australie ?", kind="none", keys=[r"canberra"]),
    dict(id="savoir_calcul", prompt="Combien font 17 fois 23 ?", kind="none", keys=[r"391"]),
    dict(id="ambigu_note", prompt="Ouvre la note.", kind="clarify", keys=[]),
    dict(id="ambigu_orca", prompt="Confie ça à Orca.", kind="clarify", keys=[]),
]

WARMUP = "Bonjour, réponds juste « prêt »."

FR_WORDS = {"le", "la", "les", "de", "des", "du", "un", "une", "et", "est", "vous", "tu", "pour", "avec", "pas",
            "que", "qui", "en", "sur", "votre", "ton", "ta", "a", "au", "aux", "il", "je", "c'est", "oui", "non"}
EN_WORDS = {"the", "and", "is", "you", "your", "for", "with", "not", "are", "of", "to", "it", "this", "that"}


def is_french(text: str) -> bool:
    w = re.findall(r"[a-zA-Z']+", norm(text))
    fr, en = sum(x in FR_WORDS for x in w), sum(x in EN_WORDS for x in w)
    return fr >= 1 and fr > en


# ------------------------------------------------------------------ appel streaming
MAX_CASE_S = 180   # au-delà, on coupe le flux (Hermes interrompt l'agent) et le cas est noté « timeout »


def ask(base: str, key: str, prompt: str, timeout: int = 120) -> dict:
    body = {"model": "default", "stream": True, "messages": [{"role": "user", "content": prompt}]}
    sid = f"floppy-eval-{uuid.uuid4().hex[:12]}"
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}",
                                          "X-Hermes-Session-Id": sid})
    t0 = time.perf_counter()
    ttft = first_reason = first_tool = None
    text, reasoning, tools, usage, timed_out = "", 0, [], None, False
    with urllib.request.urlopen(req, timeout=timeout) as r:
        event = None
        for raw in r:
            if time.perf_counter() - t0 > MAX_CASE_S:
                timed_out = True
                break
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
                continue
            if not line.startswith("data:"):
                if not line:
                    event = None
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            if event == "hermes.tool.progress":
                if obj.get("status") == "running":
                    if first_tool is None:
                        first_tool = time.perf_counter() - t0
                    tools.append({"tool": obj.get("tool"), "label": (obj.get("label") or "")[:200]})
                continue
            if event and event != "message":
                continue
            if obj.get("usage"):
                usage = obj["usage"]
            ch = obj.get("choices") or []
            delta = (ch[0].get("delta") or {}) if ch else {}
            if delta.get("reasoning_content"):
                reasoning += len(delta["reasoning_content"])
                if first_reason is None:
                    first_reason = time.perf_counter() - t0
            if delta.get("content"):
                if ttft is None:
                    ttft = time.perf_counter() - t0
                text += delta["content"]
    rnd = lambda x: round(x, 2) if x is not None else None  # noqa: E731
    return {"ttft_s": rnd(ttft), "total_s": rnd(time.perf_counter() - t0), "first_tool_s": rnd(first_tool),
            "first_reasoning_s": rnd(first_reason), "reasoning_chars": reasoning,
            "hermes_tools": tools, "text": text.strip(), "usage": usage, "session": sid, "timeout": timed_out}


def wait_idle(llama: str | None, max_s: float = 180) -> float | None:
    """Attend que llama-server n'ait plus de requête en cours (tâches annexes de Hermes : titre, etc.)."""
    if not llama:
        return None
    t0, idle_since = time.perf_counter(), None
    while time.perf_counter() - t0 < max_s:
        try:
            with urllib.request.urlopen(llama.rstrip("/") + "/metrics", timeout=3) as r:
                m = re.search(r"^llamacpp:requests_processing\s+([0-9.]+)", r.read().decode(), re.M)
            busy = m and float(m.group(1)) > 0
        except Exception:  # noqa: BLE001
            busy = False
        if busy:
            idle_since = None
        elif idle_since is None:
            idle_since = time.perf_counter()
        elif time.perf_counter() - idle_since > 1.5:
            break
        time.sleep(0.25)
    return round(time.perf_counter() - t0, 1)


def read_calls(log: Path, start: int) -> tuple[list[dict], int]:
    if not log.exists():
        return [], start
    data = log.read_bytes()
    calls = [json.loads(x) for x in data[start:].decode("utf-8", "replace").splitlines() if x.strip()]
    return calls, len(data)


# ------------------------------------------------------------------ notation
def score(case: dict, res: dict, calls: list[dict]) -> dict:
    called = [c["tool"] for c in calls]
    builtin = [t["tool"] for t in res["hermes_tools"] if t["tool"] not in BRIDGE_TOOLS
               and not t["tool"].startswith("mcp__work_tools__")]
    allowed = set(case.get("allow", []))
    for alt in case.get("need", []):
        allowed |= set(alt.split("|"))
    wrong = [t for t in called if t not in allowed] + builtin
    text_n = norm(res["text"])
    if case["kind"] == "tool":
        tool_ok = all(any(t in called for t in alt.split("|")) for alt in case["need"])
        args_ok = tool_ok
        for tool, checks in case.get("args", {}).items():
            ok_any = False
            for c in calls:
                if c["tool"] != tool:
                    continue
                if all(re.search(rx, norm(str(c["args"].get(arg) if c["args"].get(arg) is not None else "")))
                       for arg, rx in checks.items()):
                    ok_any = True
            args_ok = args_ok and ok_any
    else:
        tool_ok = not called and not builtin
        args_ok = tool_ok
    if case["kind"] == "clarify":
        answer_ok = "?" in res["text"] and not called
    else:
        answer_ok = bool(res["text"]) and all(re.search(k, text_n) for k in case.get("keys", []))
    words = len(res["text"].split())
    return {"tool_ok": tool_ok, "args_ok": args_ok, "answer_ok": answer_ok, "wrong_tools": wrong,
            "n_wrong": len(wrong), "french": is_french(res["text"]) if res["text"] else False,
            "short": 0 < words <= 80, "words": words, "work_calls": calls,
            "n_tool_events": len(res["hermes_tools"])}


def write(rec: dict) -> None:
    OUT.parent.mkdir(exist_ok=True)
    with OUT.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def suite(label: str, base: str, key: str, log: Path, runs: int, only: set[str] | None, llama: str | None) -> None:
    pos = log.stat().st_size if log.exists() else 0
    # 1 appel à froid (cache de prompt vide), puis réchauffage
    for kind in ("cold", "warmup"):
        idle = wait_idle(llama)
        try:
            res = ask(base, key, WARMUP)
        except Exception as e:  # noqa: BLE001
            res = {"error": f"{type(e).__name__}: {e}"[:300]}
        _, pos = read_calls(log, pos)
        rec = {"label": label, "kind": kind, "idle_wait_s": idle, **res}
        write(rec)
        print(json.dumps({k: rec.get(k) for k in ("label", "kind", "ttft_s", "total_s", "error")}, ensure_ascii=False), flush=True)
    for run in range(1, runs + 1):
        for case in CASES:
            if only and case["id"] not in only:
                continue
            idle = wait_idle(llama)
            try:
                res = ask(base, key, case["prompt"])
                err = None
            except Exception as e:  # noqa: BLE001
                res = {"ttft_s": None, "total_s": None, "hermes_tools": [], "text": ""}
                err = f"{type(e).__name__}: {e}"[:300]
            time.sleep(0.5)  # le journal MCP est écrit par un autre processus
            calls, pos = read_calls(log, pos)
            sc = score(case, res, calls)
            rec = {"label": label, "kind": "case", "run": run, "id": case["id"], "case_kind": case["kind"],
                   "prompt": case["prompt"], "idle_wait_s": idle, **res, **sc, "error": err}
            write(rec)
            print(f"{label} r{run} {case['id']:18s} tool={sc['tool_ok']!s:5} args={sc['args_ok']!s:5} "
                  f"ans={sc['answer_ok']!s:5} wrong={sc['wrong_tools']} ttft={res.get('ttft_s')} "
                  f"tot={res.get('total_s')} | {res['text'][:90]!r}", flush=True)


# ------------------------------------------------------------------ vitesse brute
def speed(label: str, base: str) -> None:
    root = base.rstrip("/").removesuffix("/v1")
    para = ("Floppy est un assistant vocal qui aide un développeur dans sa journée de travail : agenda, mails, "
            "pull requests, builds, notes et agents de code. ") * 60   # ~2 000 tokens
    out = {}
    for n, cache in ((256, False),):
        body = {"prompt": para + "\nRésume ce texte en dix phrases détaillées.\n", "n_predict": n,
                "cache_prompt": cache, "temperature": 0.7}
        req = urllib.request.Request(root + "/completion", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            t = json.load(r).get("timings", {})
        out = {"pp_tok_s": round(t.get("prompt_per_second", 0), 1), "pp_tokens": t.get("prompt_n"),
               "tg_tok_s": round(t.get("predicted_per_second", 0), 1), "tg_tokens": t.get("predicted_n"),
               "draft_accept": (round(t["draft_n_accepted"] / t["draft_n"], 2) if t.get("draft_n") else None)}
    rec = {"label": label, "kind": "speed", **out}
    write(rec)
    print(json.dumps(rec), flush=True)


# ------------------------------------------------------------------ rapport
def report() -> None:
    rows: dict[str, dict] = {}
    for line in OUT.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        d = rows.setdefault(r["label"], {"cases": [], "cold": [], "speed": None, "vram": None})
        if r["kind"] == "case":
            case = next((c for c in CASES if c["id"] == r["id"]), None)
            if case:   # renote avec les définitions actuelles des cas
                r.update(score(case, r, r.get("work_calls", [])))
            d["cases"].append(r)
        elif r["kind"] == "cold":
            d["cold"].append(r.get("ttft_s"))
        elif r["kind"] == "speed":
            d["speed"] = r
        elif r["kind"] == "vram":
            d["vram"] = r
    med = lambda xs: (sorted(xs)[len(xs) // 2] if xs else None)  # noqa: E731
    pct = lambda xs: round(100 * sum(xs) / len(xs)) if xs else None  # noqa: E731
    print("| Modèle | VRAM pic (Go) | tg tok/s | pp tok/s | TTFT froid (s) | TTFT chaud sans outil (s) | "
          "TTFT chaud avec outil (s) | Total avec outil (s) | Outils % | Arguments % | Réponse % | "
          "Outils en trop (travail / intégrés) | FR+court % | Correct % | n |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for label, d in rows.items():
        cs = d["cases"]
        if not cs:
            continue
        simple = [c["ttft_s"] for c in cs if c["case_kind"] != "tool" and c.get("ttft_s")]
        tool = [c["ttft_s"] for c in cs if c["case_kind"] == "tool" and c.get("ttft_s")]
        tool_tot = [c["total_s"] for c in cs if c["case_kind"] == "tool" and c.get("total_s")]
        sp, vr = d["speed"] or {}, d["vram"] or {}
        w_work = sum(sum(1 for t in c["wrong_tools"] if "__" not in t and t in WORK_TOOLS) for c in cs)
        w_all = sum(c["n_wrong"] for c in cs)
        allok = [c["tool_ok"] and c["args_ok"] and c["answer_ok"] for c in cs]
        print(f"| {label} | {vr.get('llm_gb', '?')} | {sp.get('tg_tok_s', '?')} | {sp.get('pp_tok_s', '?')} | "
              f"{d['cold'][0] if d['cold'] else '?'} | {med(simple)} | {med(tool)} | {med(tool_tot)} | "
              f"{pct([c['tool_ok'] for c in cs])} | {pct([c['args_ok'] for c in cs])} | "
              f"{pct([c['answer_ok'] for c in cs])} | {w_work} / {w_all - w_work} | "
              f"{pct([c['french'] and c['short'] for c in cs])} | {pct(allok)} | {len(cs)} |")
    print()
    print("Échecs par cas (✗ = outil, arguments ou réponse faux ; + = outils en trop) :")
    ids = [c["id"] for c in CASES]
    print("| Cas | " + " | ".join(rows) + " |")
    print("|---|" + "---|" * len(rows))
    for i in ids:
        cells = []
        for d in rows.values():
            rs = [c for c in d["cases"] if c["id"] == i]
            if not rs:
                cells.append("")
                continue
            cells.append(" ".join(("✓" if (c["tool_ok"] and c["args_ok"] and c["answer_ok"]) else "✗")
                                  + ("+" if c["n_wrong"] else "") for c in rs))
        print(f"| {i} | " + " | ".join(cells) + " |")


WORK_TOOLS = {"agenda_du_jour", "prochain_rdv", "mails_non_lus", "mes_pr_a_relire", "etat_build", "mes_tickets",
              "chercher_notes", "lire_note", "ouvrir_url", "orca_etat_agents", "orca_confier_tache"}


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "suite":
        a = sys.argv[2:]
        runs = int(a[a.index("--runs") + 1]) if "--runs" in a else 1
        only = set(a[a.index("--only") + 1].split(",")) if "--only" in a else None
        llama = a[a.index("--llama") + 1] if "--llama" in a else None
        suite(a[0], a[1], a[2], Path(a[3]), runs, only, llama)
    elif cmd == "speed":
        speed(sys.argv[2], sys.argv[3])
    elif cmd == "report":
        report()
