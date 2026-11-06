#!/usr/bin/env bash
# Passe le banc du cerveau sur plusieurs modèles, l'un après l'autre (un seul llama-server à la fois).
#   bash bench/run-models.sh qwen35b ornith flint     (configs : bench/local/<nom>.yml)
cd "$(dirname "$0")/.."
PY="python -X utf8"   # la notation n'utilise que la bibliothèque standard
export PYTHONIOENCODING=utf-8
for m in "$@"; do
  export FLOPPY_HOME="$TEMP/floppy-bench-$m"; rm -rf "$FLOPPY_HOME"
  echo "== $m : démarrage $(date +%T)"
  npx floppy start -c "bench/local/$m.yml" > "bench/out/floppy-$m.log" 2>&1 &
  PID=$!
  ok=0
  for i in $(seq 1 300); do
    curl -s -m 2 http://127.0.0.1:8751/v1/models >/dev/null 2>&1 && { ok=1; break; }
    kill -0 $PID 2>/dev/null || break
    sleep 1
  done
  if [ $ok = 1 ]; then
    echo "== $m : banc $(date +%T)"
    $PY bench/eval.py run "noyau-$m" > "bench/out/run-$m.log" 2>&1
    echo "== $m : fini $(date +%T)"
  else
    echo "== $m : ÉCHEC du démarrage (voir bench/out/floppy-$m.log)"
  fi
  WPID=$(cat /proc/$PID/winpid 2>/dev/null); [ -n "$WPID" ] && taskkill //PID $WPID //T //F > /dev/null 2>&1; kill $PID 2>/dev/null
  for i in $(seq 1 30); do curl -s -m 1 http://127.0.0.1:8080/health >/dev/null 2>&1 || break; sleep 1; done
done
$PY bench/eval.py report $(for m in "$@"; do printf 'noyau-%s ' "$m"; done) > bench/out/report-models.txt 2>&1
echo "== rapport : bench/out/report-models.txt"
