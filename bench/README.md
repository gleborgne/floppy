# Banc du cerveau

Les 40 demandes notées des prototypes (`harness/cases_new.py` et `harness/eval_base.py`), passées à travers le noyau
par le plugin `dev/bench-api` (API compatible OpenAI sur `127.0.0.1:8751`). La notation n'utilise que la bibliothèque
standard de Python. Le faux serveur de travail (`work_mcp/server.py`) a besoin du paquet `mcp` : `uv sync --project bench`.

1. Copier `bench/bench.yml` en `bench/local/<nom>.yml` (dossier ignoré par git) et y mettre le chemin du modèle GGUF.
2. Lancer :

```powershell
# depuis la racine du dépôt
$env:FLOPPY_HOME = "$env:TEMP\floppy-bench"
$env:FLOPPY_DEV = "1"   # le plugin bench-api n'existe qu'en mode développement
npx floppy start -c bench/local/<nom>.yml
# autre terminal :
python -X utf8 bench/eval.py run <label>
python -X utf8 bench/eval.py report <label>
```

Plusieurs modèles à la suite : `bash bench/run-models.sh <nom1> <nom2>` (un seul llama-server à la fois).
Vitesse brute de llama-server (lecture, MTP, contexte) : `python bench/speed.py <gguf> <sortie.jsonl> [--exe <llama-server>]`.

Résultats : voir `docs/spec/proto.md#mesures`.

## Jeu expressif de la voix locale

Depuis la racine du dépôt, avec un modèle Qwen CustomVoice **1.7B** déjà installé :

```powershell
node bench/voice-compare.ts --model C:/models/qwen3-tts-1.7b-customvoice.gguf --exe C:/programs/audiocpp_server.exe --voice ono_anna
```

Le banc utilise les vrais plugins et leur cycle de vie, dans un noyau isolé. Il produit trois paires WAV
(expliquer, rassurer, plaisanter ; témoin puis profil joueur) et `results.json` dans `bench/out/voice-compare`.
La voix habituelle et les réglages utilisateur restent intacts. Le serveur temporaire utilise le port 8099
(`--port` pour en choisir un autre) et s'arrête à la fin, même en cas d'erreur. `--backend cpu` force le processeur.
Un autre dossier de sortie se choisit avec `--output`.

Les temps mesurent le premier bloc audio et la génération complète, **après chargement du modèle**.
Un seul passage sert à comparer l'écoute ; répéter les mesures et alterner l'ordre des essais avant de conclure
sur la vitesse. La durée des fichiers ne prouve ni la qualité ni le respect des consignes.
