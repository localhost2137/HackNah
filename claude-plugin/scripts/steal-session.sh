#!/usr/bin/env bash
# Demo: start Claude Code on an "attacker laptop" with credentials stolen from the
# victim (tokens.json copied, e.g. by an infostealer), but without the victim's device key.
#
#   1. scripts/dev-claude.sh                 victim signs in normally (state in /tmp/hy-data)
#   2. scripts/steal-session.sh              attacker session with the copied tokens.json
#   3. open http://127.0.0.1:8787/           "Rejected credentials" + "token theft suspected"
#
# Expected in the attacker's Claude Code:
#   - model requests fail: "token is bound to a different key"
#   - no company tools; hy_status shows the session was refused
# Start the mock with MOCK_TRUST_IP_HEADER=1 so it believes the attacker is in Singapore.
#
# --copy-key: also copy the device key (possible with software keys, e.g. on Linux) and run
#   as a different machine. Every DPoP proof is now valid; the device fingerprint (dfp)
#   is what gives it away: "same key used from a different machine".
#   (A Secure Enclave key blob only works on the Mac that made it; on this Mac the demo
#   still shows the fingerprint check.)
#
# Usage: scripts/steal-session.sh [--copy-key] [victim data dir] [claude args...]   (default /tmp/hy-data)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COPY_KEY=0
if [[ "${1:-}" == "--copy-key" ]]; then COPY_KEY=1; shift; fi
VICTIM_DIR="${1:-/tmp/hy-data}"
[[ $# -gt 0 ]] && shift
ATTACKER_DIR="${HY_ATTACKER_DIR:-/tmp/hy-attacker}"

if [[ ! -s "$VICTIM_DIR/tokens.json" ]]; then
  echo "no tokens at $VICTIM_DIR/tokens.json; sign in as the victim first: scripts/dev-claude.sh" >&2
  exit 1
fi

rm -rf "$ATTACKER_DIR"
mkdir -p "$ATTACKER_DIR"
cp "$VICTIM_DIR/tokens.json" "$ATTACKER_DIR/tokens.json"
if [[ $COPY_KEY == 1 ]]; then
  cp -R "$VICTIM_DIR/keys" "$ATTACKER_DIR/keys"
  # use whichever kind of key the victim had
  if [[ -f "$ATTACKER_DIR/keys/routine.pem" ]]; then export HY_KEY_PROVIDER=software; else export HY_KEY_PROVIDER=secure-enclave; fi
  export HY_SIMULATE_MACHINE_ID="attacker-machine-$(date +%s)"
  echo "copied victim tokens.json AND device key -> $ATTACKER_DIR, running as another machine" >&2
else
  # A different machine: fresh data dir, so a brand-new device key.
  export HY_SIMULATE_STOLEN=1 # send the tokens even though they're bound to another key
  echo "copied victim tokens.json -> $ATTACKER_DIR (no device key copied)" >&2
fi

export CLAUDE_CONFIG_DIR="${HY_ATTACKER_PROFILE:-$HOME/.claude-hy-attacker}"
export HY_DATA_DIR="$ATTACKER_DIR"
export HY_LLM_PORT="${HY_ATTACKER_LLM_PORT:-47822}" # never reuse the victim's running proxy
export HY_SIMULATE_IP="${HY_SIMULATE_IP:-203.0.113.7}"
export HY_AUTO_LOGIN=0
export HY_SKIP_LOGIN=1

lsof -nP -tiTCP:"$HY_LLM_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
exec "$ROOT/scripts/dev-claude.sh" "$@"
