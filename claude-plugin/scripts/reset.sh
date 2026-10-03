#!/usr/bin/env bash
# Reset the demo to a clean state.
#
#   npm run reset               stop this repo's processes, delete mock state + /tmp demo data
#   npm run reset -- --all      also delete mock keys and the two test Claude Code profiles
#   npm run reset -- --dry-run  only show what would happen
#
# Only touches this repository's processes and the fixed demo paths listed below.
# Never touches your normal Claude Code profile (~/.claude, ~/.claude.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALL=0
DRY=0
for a in "$@"; do
  case "$a" in
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a (use --all, --dry-run)" >&2; exit 2 ;;
  esac
done

run() {
  if [[ $DRY == 1 ]]; then echo "  would: $*"; else "$@"; fi
}

echo "Stopping hy-guard processes from $ROOT"
found=0
for pid in $(pgrep -f "plugin/bridge/main.mjs|mock-backend/server.mjs" || true); do
  [[ "$pid" == "$$" ]] && continue
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  [[ -z "$cmd" ]] && continue
  # Leave a running test suite alone (its bridges/mocks are children of scripts/e2e.mjs).
  parent="$(ps -o command= -p "$(ps -o ppid= -p "$pid" | tr -d ' ')" 2>/dev/null || true)"
  [[ "$parent" == *"scripts/e2e.mjs"* ]] && continue
  # Only processes of this repo: absolute path in the command, or started from this directory.
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  if [[ "$cmd" == *"$ROOT/"* || "$cwd" == "$ROOT" ]]; then
    echo "  $pid  ${cmd:0:110}"
    run kill "$pid"
    found=1
  fi
done
[[ $found == 0 ]] && echo "  (none running)"

echo "Deleting demo data"
paths=(
  "$ROOT/mock-backend/.data/state.json" # mock devices, tokens, decisions, events, CrowdStrike hosts
  /tmp/hy-data                         # victim device: keys, tokens, pins, logs
  /tmp/hy-attacker                     # steal-session.sh "attacker laptop"
  /tmp/hy-zta                          # mock CrowdStrike ZTA file
)
if [[ $ALL == 1 ]]; then
  paths+=(
    "$ROOT/mock-backend/.data"   # platform signing key, mock CrowdStrike key, mock agent ID
    "$HOME/.claude-hy-test"      # test Claude Code profile (scripts/dev-claude.sh)
    "$HOME/.claude-hy-attacker"  # attacker test profile (scripts/steal-session.sh)
    "$HOME/.claude-hy-plain"     # plain-claude profile (scripts/setup-profile.sh)
  )
fi
for p in "${paths[@]}"; do
  if [[ -e "$p" ]]; then
    echo "  $p"
    run rm -rf "$p"
  fi
done

if [[ $DRY == 1 ]]; then
  echo "Dry run: nothing changed."
else
  echo "Clean. Start again with:"
  echo "  MOCK_TRUST_IP_HEADER=1 npm run mock     # terminal 1"
  echo "  npm run zta -- 90 && scripts/dev-claude.sh   # terminal 2"
fi
