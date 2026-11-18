#!/usr/bin/env bash
# PostToolUse hook: formats the file the agent just wrote.
# Options are passed on the command line with --no-config, so repo config files
# (and any plugins they name) are not loaded. In GitHub Actions the hook is
# skipped: npx could resolve prettier from node_modules installed from a PR's
# lockfile, so the agent runs `pnpm format` there instead.
set -uo pipefail

[ -n "${GITHUB_ACTIONS:-}" ] && exit 0

file_path="$(jq -r '.tool_input.file_path // empty')"
[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

npx --yes prettier@3.10.1 --no-config --no-editorconfig --write --ignore-unknown \
  --print-width 100 --trailing-comma all "$file_path" >/dev/null 2>&1 || true
exit 0
