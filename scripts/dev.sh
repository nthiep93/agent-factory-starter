#!/usr/bin/env bash
# Starts api and web on this checkout's ports (see scripts/worktree.sh).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

WEB_PORT=3000
API_PORT=3001
# shellcheck disable=SC1091
[ -f .worktree.env ] && . ./.worktree.env

pnpm --filter @repo/shared build >/dev/null

echo "api: http://localhost:$API_PORT/health"
echo "web: http://localhost:$WEB_PORT"

trap 'kill 0' EXIT INT TERM
PORT="$API_PORT" pnpm --filter api dev &
NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" pnpm --filter web exec next dev --port "$WEB_PORT" &
wait
