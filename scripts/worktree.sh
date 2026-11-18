#!/usr/bin/env bash
# Parallel agent workspaces that do not collide.
#
#   scripts/worktree.sh new <name> [base]   create .claude/worktrees/<name> on branch wt/<name>
#   scripts/worktree.sh list                show worktrees with their ports
#   scripts/worktree.sh rm <name>           remove the worktree (keeps the branch)
#
# git worktrees isolate files but not ports. Each worktree gets a slot N (1-9):
# web on 3000+10N, api on 3001+10N. The main checkout is slot 0 (3000/3001).
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# Run from the main checkout even when called inside a worktree.
main_root="$(git -C "$root" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
wt_dir="$main_root/.claude/worktrees"

die() { echo "error: $*" >&2; exit 1; }

used_slots() {
  for f in "$wt_dir"/*/.worktree.env; do
    [ -f "$f" ] && sed -n 's/^WORKTREE_SLOT=//p' "$f"
  done
}

free_slot() {
  local used
  used="$(used_slots | tr '\n' ' ')"
  for n in 1 2 3 4 5 6 7 8 9; do
    [[ " $used " == *" $n "* ]] || { echo "$n"; return; }
  done
  die "all 9 slots are in use; remove a worktree first"
}

cmd_new() {
  local name="${1:-}" base="${2:-main}"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "name must be lowercase letters, digits and dashes"
  local path="$wt_dir/$name"
  [ -e "$path" ] && die "$path already exists"

  local slot web_port api_port
  slot="$(free_slot)"
  web_port=$((3000 + 10 * slot))
  api_port=$((3001 + 10 * slot))

  mkdir -p "$wt_dir"
  git -C "$main_root" worktree add -q "$path" -b "wt/$name" "$base"

  # Copy untracked local files listed in .worktreeinclude (e.g. .env).
  if [ -f "$main_root/.worktreeinclude" ]; then
    while read -r f; do
      case "$f" in "" | \#*) continue ;; esac
      if [ -f "$main_root/$f" ]; then cp "$main_root/$f" "$path/$f"; fi
    done < "$main_root/.worktreeinclude"
  fi

  cat > "$path/.worktree.env" <<EOF
WORKTREE_SLOT=$slot
WEB_PORT=$web_port
API_PORT=$api_port
EOF

  (cd "$path" && pnpm install --frozen-lockfile --prefer-offline --silent)

  echo "created $path"
  echo "  branch: wt/$name (from $base)"
  echo "  ports:  web $web_port, api $api_port  (pnpm dev)"
  echo "  agent:  cd $path && claude"
}

cmd_list() {
  printf "%-24s %-30s %-6s %-6s\n" NAME BRANCH WEB API
  printf "%-24s %-30s %-6s %-6s\n" "(main)" "$(git -C "$main_root" branch --show-current)" 3000 3001
  for d in "$wt_dir"/*/; do
    [ -f "$d/.worktree.env" ] || continue
    # shellcheck disable=SC1091
    ( . "$d/.worktree.env"
      printf "%-24s %-30s %-6s %-6s\n" "$(basename "$d")" "$(git -C "$d" branch --show-current)" "$WEB_PORT" "$API_PORT" )
  done
}

cmd_rm() {
  local name="${1:-}" path="$wt_dir/${1:-}"
  [ -n "$name" ] && [ -d "$path" ] || die "no worktree named '$name'"
  if [ -n "$(git -C "$path" status --porcelain -- . ':!.worktree.env' ':!node_modules')" ]; then
    die "'$name' has uncommitted changes; commit or discard them first"
  fi
  git -C "$main_root" worktree remove --force "$path"
  echo "removed $path (branch wt/$name kept)"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) cmd_list ;;
  rm) shift; cmd_rm "$@" ;;
  *) awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 1 ;;
esac
