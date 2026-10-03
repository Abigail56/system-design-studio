#!/usr/bin/env bash
# Starts the whole Ghost AI stack for local development.
#
#   ./dev.sh          each service in its own window
#   ./dev.sh -d       run in this window, Ctrl+C stops everything
#
# See README.md for starting any single service on its own.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
detach=1
[ "${1:-}" = "-d" ] && detach=0

if [ ! -f "$root/api/.venv/bin/python" ]; then
  echo "backend/.venv missing. Create it first:" >&2
  echo "  cd api && uv venv && uv pip install -e '.[dev]'" >&2
fi
if [ ! -d "$root/ghost/node_modules" ]; then
  echo "frontend/node_modules missing. Run 'npm install' in frontend/ first." >&2
fi

run() { # name dir command
  echo "Starting $1 in $2"
  if [ "$detach" = "1" ]; then
    (cd "$2" && eval "$3") &
  else
    (cd "$2" && eval "$3")
  fi
}

if [ "$detach" = "0" ]; then
  trap 'kill 0' EXIT INT TERM
  run db  "$root"      'docker compose up -d db' &
  sleep 3
  run api "$root/api"  '.venv/bin/python -m uvicorn app.main:app --port 8000 --reload' &
  run web "$root/ghost" 'npm run dev' &
  wait
else
  run db  "$root"      'docker compose up -d db'
  sleep 3
  run api "$root/api"  '.venv/bin/python -m uvicorn app.main:app --port 8000 --reload' &
  run web "$root/ghost" 'npm run dev' &
  wait
fi

cat <<EOF

  web  http://localhost:3000
  api  http://localhost:8000/docs
  db   postgresql://ghost:ghost@localhost:55432/ghost
EOF