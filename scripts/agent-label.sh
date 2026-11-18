#!/usr/bin/env bash
# Labels a recorded agent run.
#
#   scripts/agent-label.sh <run-id> <success|flawed|blocked|manual> ["note"]
#
#   success  merged as is, or with trivial edits
#   flawed   ran but the result was wrong: fix the prompt, AGENTS.md or tests
#   blocked  could not proceed: missing credential, service or permission
#   manual   you took over and did it yourself
set -euo pipefail

id="${1:-}" label="${2:-}" note="${3:-}"
case "$label" in
  success | flawed | blocked | manual) ;;
  *) awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 1 ;;
esac

main_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
log="$main_root/.agent-runs/runs.jsonl"
[ -f "$log" ] || { echo "error: no runs recorded yet" >&2; exit 1; }
grep -q "\"id\":\"$id\"" "$log" || { echo "error: run '$id' not found" >&2; exit 1; }

tmp="$(mktemp)"
jq -c --arg id "$id" --arg label "$label" --arg note "$note" \
  'if .id == $id then .label = $label | .note = (if $note == "" then .note else $note end) else . end' \
  "$log" >"$tmp" && mv "$tmp" "$log"
echo "$id -> $label"
