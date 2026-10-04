#!/usr/bin/env bash
# Start an isolated Claude Code session where the plugin's sign-in is the ONLY login:
#   - model requests go to a local proxy (127.0.0.1:$HY_LLM_PORT) that DPoP-signs each
#     one with the device key and forwards to the platform's LLM gateway
#   - MCP tools go through the plugin's bridge, also DPoP-signed
# No Anthropic account login: the platform's gateway holds the provider key.
#
# Usage:
#   scripts/dev-claude.sh            real browser for sign-in and approvals
#   scripts/dev-claude.sh --auto     headless: fake browser (start the mock with npm run mock:auto)
#   scripts/dev-claude.sh --fresh    forget the test device key/tokens first ("new laptop")
#   Extra arguments go to claude, e.g. scripts/dev-claude.sh -p "list my company tools"
#
# The mock needs either UPSTREAM_ANTHROPIC_API_KEY (real model) or MOCK_LLM_FAKE=1 (canned reply).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/plugin/bridge/main.mjs"

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-hy-test}"
# The default profile keeps its config in ~/.claude.json, not ~/.claude/.claude.json,
# so pointing CLAUDE_CONFIG_DIR at ~/.claude creates a second, empty profile there.
if [[ "$(cd "$CLAUDE_CONFIG_DIR" 2>/dev/null && pwd)" == "$HOME/.claude" ]]; then
  echo "refusing CLAUDE_CONFIG_DIR=~/.claude (that is not your main profile); unset it or use another dir" >&2
  exit 1
fi
export HY_DATA_DIR="${HY_DATA_DIR:-/tmp/hy-data}"
export HY_PLATFORM_URL="${HY_PLATFORM_URL:-http://localhost:3000}"
export HY_LLM_PORT="${HY_LLM_PORT:-47821}"
# EDR posture: the real CrowdStrike file if this Mac has a Falcon sensor, else the
# mock one written by `npm run zta -- <score>`.
if [[ -z "${HY_ZTA_FILE:-}" && ! -f "/Library/Application Support/Crowdstrike/ZeroTrustAssessment/data.zta" ]]; then
  export HY_ZTA_FILE=/tmp/hy-zta/data.zta
fi

args=()
for a in "$@"; do
  case "$a" in
    --auto) export HY_BROWSER_CMD="node $ROOT/scripts/fake-browser.mjs" ;;
    --fresh)
      rm -rf "$HY_DATA_DIR"
      # the proxy on our port still holds the old key
      lsof -nP -tiTCP:"$HY_LLM_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
      ;;
    *) args+=("$a") ;;
  esac
done

if ! curl -fsS "$HY_PLATFORM_URL/.well-known/hy-platform" >/dev/null 2>&1; then
  echo "gateway not reachable at $HY_PLATFORM_URL; start it with: pnpm dev (in the repository root)" >&2
  exit 1
fi

# 1. Plugin sign-in (browser SSO + device approval), before Claude Code starts.
#    HY_SKIP_LOGIN=1 is used by steal-session.sh: the attacker has tokens, not a login.
if [[ "${HY_SKIP_LOGIN:-0}" != 1 ]] && ! node "$BRIDGE" status | grep -q '"signed_in": true'; then
  node "$BRIDGE" login
fi

# 2. Test profile settings: model traffic through the local signing proxy.
#    apiKeyHelper starts the proxy and prints its local key.
mkdir -p "$CLAUDE_CONFIG_DIR"
# Does the platform's LLM gateway support auto mode's server-side checks? (discovery)
HY_AUTO_MODE_SERVER="$(curl -fsS "$HY_PLATFORM_URL/.well-known/hy-platform" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).llm_auto_mode_server;console.log(v===false?"false":v===true?"true":"unknown")}catch{console.log("unknown")}})')"
export HY_AUTO_MODE_SERVER
# Skip the first-run theme picker and security notes in the test profile.
# The per-folder trust prompt still appears once; it's a real safety check.
FIRST_RUN=0
if [[ ! -f "$CLAUDE_CONFIG_DIR/.claude.json" ]]; then
  FIRST_RUN=1
  echo '{"hasCompletedOnboarding": true, "theme": "dark"}' >"$CLAUDE_CONFIG_DIR/.claude.json"
fi
FIRST_RUN=$FIRST_RUN node - "$CLAUDE_CONFIG_DIR/settings.json" "$BRIDGE" <<'EOF'
const fs = require('node:fs');
const [file, bridge] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
s.apiKeyHelper = `node "${bridge}" llm-key`;
// Auto mode's safety checks run server-side (inside the normal model request) when the
// gateway can pass them to Anthropic's API, client-side otherwise (separate classifier
// requests). Same checks either way. Only when the platform says it can't do server-side
// (e.g. the mock's scripted model) skip trying, so there's no "isn't eligible" notice.
if (process.env.HY_AUTO_MODE_SERVER === 'false') (s.env ??= {}).CLAUDE_CODE_AUTO_MODE_SERVER = '0';
else delete s.env?.CLAUDE_CODE_AUTO_MODE_SERVER;
// UI overrides only when set in this shell; otherwise the plugin's /config settings decide.
for (const k of ['HY_UI_CARDS', 'HY_UI_STATUS', 'HY_UI_BAND']) if (!process.env[k]) delete s.env?.[k];
s.env = {
  ...(s.env ?? {}),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${process.env.HY_LLM_PORT}`,
  HY_DATA_DIR: process.env.HY_DATA_DIR,
  HY_PLATFORM_URL: process.env.HY_PLATFORM_URL,
  HY_LLM_PORT: process.env.HY_LLM_PORT,
  ...Object.fromEntries(
    ['HY_SIMULATE_STOLEN', 'HY_SIMULATE_IP', 'HY_SIMULATE_MACHINE_ID', 'HY_SIMULATE_IDLE', 'HY_SIMULATE_OS_POSTURE', 'HY_ZTA_FILE', 'HY_UI_CARDS', 'HY_UI_STATUS', 'HY_UI_BAND', 'HY_AUTO_LOGIN', 'HY_KEY_PROVIDER']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  ),
  ...(process.env.HY_BROWSER_CMD ? { HY_BROWSER_CMD: process.env.HY_BROWSER_CMD } : {}),
};
// The plugin's tools are pre-allowed; hy-guard's own approval levels still apply.
s.permissions = { ...(s.permissions ?? {}), allow: [...new Set([...(s.permissions?.allow ?? []), 'mcp__plugin_hy-guard_gateway'])] };
// New profile: start in manual mode (auto mode sends classifier requests the scripted mock
// model can't answer). After that Claude Code keeps whatever you choose.
if (process.env.FIRST_RUN === '1' && !s.permissions.defaultMode) s.permissions.defaultMode = 'manual';
fs.writeFileSync(file, JSON.stringify(s, null, 2));
EOF

exec claude --plugin-dir "$ROOT/plugin" ${args[@]+"${args[@]}"}
