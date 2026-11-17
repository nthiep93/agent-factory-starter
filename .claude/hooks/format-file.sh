#!/usr/bin/env bash
# PostToolUse hook: formats the file the agent just wrote.
# Prettier version is pinned and repo config is ignored, so a PR cannot change what runs here.
set -uo pipefail

file_path="$(jq -r '.tool_input.file_path // empty')"
[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

npx --yes prettier@3.10.1 --write --ignore-unknown --print-width 100 --trailing-comma all "$file_path" >/dev/null 2>&1 || true
exit 0
