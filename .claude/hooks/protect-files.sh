#!/usr/bin/env bash
# PreToolUse hook: blocks edits to files an agent must never change.
# Exit code 2 blocks the tool call and sends stderr back to the agent.
set -euo pipefail

file_path="$(jq -r '.tool_input.file_path // empty')"
[ -z "$file_path" ] && exit 0

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file_path#"$project_dir"/}"

protected=(
  ".github/workflows/"
  "holdout/"
  ".claude/settings.json"
  ".claude/hooks/"
  ".env"
  "secrets/"
  "pnpm-lock.yaml"
)

[[ "$rel" == ".env.example" ]] && exit 0

for pattern in "${protected[@]}"; do
  # Patterns ending in "/" match a whole directory; ".env" also covers ".env.local" etc.;
  # everything else must match the path exactly.
  if [[ ("$pattern" == */ && "$rel" == "$pattern"*) || "$rel" == "$pattern" || ("$pattern" == ".env" && "$rel" == .env.*) ]]; then
    echo "Blocked: '$rel' is protected ($pattern). CI, holdout scenarios, agent guardrails, secrets and the lockfile are changed by humans only. Stop and explain what change you need." >&2
    exit 2
  fi
done

exit 0
