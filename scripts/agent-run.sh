#!/usr/bin/env bash
# Runs one headless Claude Code task and records it for later review.
#
#   scripts/agent-run.sh [-w <worktree>] [-b <budget-usd>] "<task prompt>"
#
# - Runs in .claude/worktrees/<worktree> when -w is given, otherwise here.
# - Uses the project's CLAUDE.md, hooks and permissions (no --bare), plus
#   edit and local git commit rights. It never pushes.
# - After the agent stops, runs `pnpm verify` itself: the agent's own claim
#   of success is not evidence.
# - Appends one JSON line to .agent-runs/runs.jsonl. Label it afterwards with
#   scripts/agent-label.sh <id> success|flawed|blocked|manual.
set -uo pipefail

worktree="" budget="2"
while getopts "w:b:" opt; do
  case "$opt" in
    w) worktree="$OPTARG" ;;
    b) budget="$OPTARG" ;;
    *) exit 1 ;;
  esac
done
shift $((OPTIND - 1))
prompt="${1:-}"
[ -n "$prompt" ] || { awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 1; }

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }
command -v claude >/dev/null || { echo "error: claude CLI not found" >&2; exit 1; }

main_root="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
dir="$main_root"
[ -n "$worktree" ] && dir="$main_root/.claude/worktrees/$worktree"
[ -d "$dir" ] || { echo "error: $dir does not exist (scripts/worktree.sh new $worktree)" >&2; exit 1; }

log_dir="$main_root/.agent-runs"
mkdir -p "$log_dir"
id="$(date +%Y%m%d-%H%M%S)-$RANDOM"
out="$log_dir/$id.json"
err="$log_dir/$id.stderr.log"

branch="$(git -C "$dir" branch --show-current)"
head_before="$(git -C "$dir" rev-parse HEAD)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
t0=$(date +%s)

echo "run $id in ${worktree:-main checkout} ($branch), budget \$$budget"

(cd "$dir" && claude -p "$prompt" \
  --output-format json \
  --permission-mode dontAsk \
  --allowedTools "Edit" "Write" "Bash(git add *)" "Bash(git commit *)" \
  --max-budget-usd "$budget") >"$out" 2>"$err"
exit_code=$?

verify="fail"
(cd "$dir" && pnpm verify >"$log_dir/$id.verify.log" 2>&1) && verify="pass"

duration=$(( $(date +%s) - t0 ))
commits="$(git -C "$dir" rev-list --count "$head_before"..HEAD)"
dirty="$( [ -n "$(git -C "$dir" status --porcelain)" ] && echo true || echo false)"

# Agent output may not be valid JSON if the CLI failed early.
agent_json='{}'
jq -e . "$out" >/dev/null 2>&1 && agent_json="$(cat "$out")"

jq -nc \
  --arg id "$id" --arg started "$started" --arg dir "${worktree:-main}" \
  --arg branch "$branch" --arg prompt "$prompt" --arg verify "$verify" \
  --argjson exit "$exit_code" --argjson duration "$duration" \
  --argjson commits "$commits" --argjson dirty "$dirty" --argjson budget "$budget" \
  --argjson agent "$agent_json" \
  '{id: $id, startedAt: $started, worktree: $dir, branch: $branch, prompt: $prompt,
    exitCode: $exit, isError: (if $agent | has("is_error") then $agent.is_error else null end), costUsd: ($agent.total_cost_usd // null),
    budgetUsd: $budget, numTurns: ($agent.num_turns // null), sessionId: ($agent.session_id // null),
    durationSec: $duration, commits: $commits, uncommittedChanges: $dirty,
    verify: $verify, label: null, note: null}' >>"$log_dir/runs.jsonl"

echo "exit=$exit_code verify=$verify commits=$commits uncommitted=$dirty duration=${duration}s"
echo "result: $(jq -r '.result // "(no result, see '"$err"')"' "$out" 2>/dev/null | head -c 400)"
echo "label it: scripts/agent-label.sh $id success|flawed|blocked|manual [\"note\"]"
