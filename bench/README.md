# Banc du cerveau

Les 40 demandes notées des prototypes (`harness/cases_new.py` et `harness/eval_base.py`), passées à travers le noyau
par le plugin `dev/bench-api` (API compatible OpenAI sur `127.0.0.1:8751`). La notation n'utilise que la bibliothèque
standard de Python. Le faux serveur de travail (`work_mcp/server.py`) a besoin du paquet `mcp` : `uv sync --project bench`.

1. Copier `bench/bench.yml` en `bench/local/<nom>.yml` (dossier ignoré par git) et y mettre le chemin du modèle GGUF.
2. Lancer :

```powershell
# depuis la racine du dépôt
$env:FLOPPY_HOME = "$env:TEMP\floppy-bench"
npx floppy start -c bench/local/<nom>.yml
# autre terminal :
python -X utf8 bench/eval.py run <label>
python -X utf8 bench/eval.py report <label>
```

Plusieurs modèles à la suite : `bash bench/run-models.sh <nom1> <nom2>` (un seul llama-server à la fois).
Vitesse brute de llama-server (lecture, MTP, contexte) : `python bench/speed.py <gguf> <sortie.jsonl> [--exe <llama-server>]`.

Résultats : voir `docs/spec/proto.md#mesures`.
