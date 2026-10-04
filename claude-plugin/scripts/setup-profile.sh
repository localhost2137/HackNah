#!/usr/bin/env bash
# Prepare a separate Claude Code profile so plain `claude` runs with hy-guard, the way a
# company rollout would (managed settings + plugin from the company marketplace):
#
#   npm run setup-profile                       # once, and again after changing the plugin
#   CLAUDE_CONFIG_DIR=~/.claude-hy-plain claude # then just this (or an alias, see the end)
#
# For demos use scripts/dev-claude.sh instead (live plugin from the repo, --auto/--fresh,
# steal-session.sh). This is the "no wrapper" path, in its own profile so the installed
# plugin never meets the --plugin-dir one.
#
# Writes only into the profile ($CLAUDE_CONFIG_DIR, default ~/.claude-hy-plain):
#   - plugin hy-guard installed from this repository as a local marketplace ("hy-local")
#   - model traffic through the local signing proxy (apiKeyHelper + ANTHROPIC_BASE_URL),
#     so the profile needs no Anthropic login
#   - HY_* settings (platform URL, data dir, ...), plugin tools pre-allowed
#   - first run only: onboarding skipped, permission mode "manual" (the scripted mock
#     model can't answer auto mode's classifier). After that your own choices stick.
# Never touches your normal profile (~/.claude, ~/.claude.json).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$ROOT/plugin/bridge/main.mjs"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1
say() { [[ $QUIET == 1 ]] || echo "$@"; }

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-hy-plain}"
if [[ "$(cd "$CLAUDE_CONFIG_DIR" 2>/dev/null && pwd)" == "$HOME/.claude" ]]; then
  echo "refusing CLAUDE_CONFIG_DIR=~/.claude (that is not your main profile); unset it or use another dir" >&2
  exit 1
fi
export HY_DATA_DIR="${HY_DATA_DIR:-/tmp/hy-data}"
export HY_PLATFORM_URL="${HY_PLATFORM_URL:-http://localhost:3000}"
export HY_LLM_PORT="${HY_LLM_PORT:-47821}"
# EDR posture: the real CrowdStrike file if this Mac has a Falcon sensor, else the mock one.
if [[ -z "${HY_ZTA_FILE:-}" && ! -f "/Library/Application Support/Crowdstrike/ZeroTrustAssessment/data.zta" ]]; then
  export HY_ZTA_FILE=/tmp/hy-zta/data.zta
fi

mkdir -p "$CLAUDE_CONFIG_DIR"
# Does the platform's LLM gateway support auto mode's server-side checks? (discovery)
HY_AUTO_MODE_SERVER="$(curl -fsS "$HY_PLATFORM_URL/.well-known/hy-platform" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).llm_auto_mode_server;console.log(v===false?"false":v===true?"true":"unknown")}catch{console.log("unknown")}})')"
export HY_AUTO_MODE_SERVER
FIRST_RUN=0
if [[ ! -f "$CLAUDE_CONFIG_DIR/.claude.json" ]]; then
  FIRST_RUN=1
  echo '{"hasCompletedOnboarding": true, "theme": "dark"}' >"$CLAUDE_CONFIG_DIR/.claude.json"
fi

# Plugin: installed as a copy of ./plugin. The version stays 0.1.0 while we develop, so
# refresh the copy by reinstalling.
if ! claude plugin marketplace list 2>/dev/null | grep -q "hy-local"; then
  claude plugin marketplace add "$ROOT" >/dev/null
fi
if claude plugin list 2>/dev/null | grep -q "hy-guard@hy-local"; then
  claude plugin uninstall hy-guard@hy-local >/dev/null 2>&1 || true
fi
claude plugin marketplace update hy-local >/dev/null 2>&1 || true
claude plugin install hy-guard@hy-local >/dev/null

# Settings
FIRST_RUN=$FIRST_RUN node - "$CLAUDE_CONFIG_DIR/settings.json" "$BRIDGE" <<'EOF'
const fs = require('node:fs');
const [file, bridge] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
s.apiKeyHelper = `node "${bridge}" llm-key`;
s.env = {
  ...(s.env ?? {}),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${process.env.HY_LLM_PORT}`,
  // Sends a prompt id with each model request, so the gateway groups a prompt's requests
  // (subagents included) into one trace.
  CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
  HY_DATA_DIR: process.env.HY_DATA_DIR,
  HY_PLATFORM_URL: process.env.HY_PLATFORM_URL,
  HY_LLM_PORT: process.env.HY_LLM_PORT,
  ...(process.env.HY_ZTA_FILE ? { HY_ZTA_FILE: process.env.HY_ZTA_FILE } : {}),
};
// Auto mode's safety checks run server-side (inside the normal model request) when the
// gateway can pass them to Anthropic's API, client-side otherwise (separate classifier
// requests). Same checks either way. Only when the platform says it can't do server-side
// (e.g. the mock's scripted model) skip trying, so there's no "isn't eligible" notice.
if (process.env.HY_AUTO_MODE_SERVER === 'false') s.env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
else delete s.env.CLAUDE_CODE_AUTO_MODE_SERVER;
// Demo/override variables only when set in this shell; otherwise /config decides.
for (const k of ['HY_SIMULATE_STOLEN', 'HY_SIMULATE_IP', 'HY_SIMULATE_MACHINE_ID', 'HY_SIMULATE_IDLE',
  'HY_SIMULATE_OS_POSTURE', 'HY_AUTO_LOGIN', 'HY_KEY_PROVIDER', 'HY_BROWSER_CMD', 'HY_UI_CARDS', 'HY_UI_STATUS', 'HY_UI_BAND']) {
  if (process.env[k]) s.env[k] = process.env[k];
  else delete s.env[k];
}
s.permissions = { ...(s.permissions ?? {}) };
s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), 'mcp__plugin_hy-guard_gateway'])];
// First run only; afterwards whatever you choose in Claude Code is kept.
if (process.env.FIRST_RUN === '1' && !s.permissions.defaultMode) s.permissions.defaultMode = 'manual';
fs.writeFileSync(file, JSON.stringify(s, null, 2));
EOF

say "Profile ready: $CLAUDE_CONFIG_DIR (plugin hy-guard@hy-local, platform $HY_PLATFORM_URL)"
say ""
say "Start Claude Code with it:"
say "  CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR claude"
say ""
say "Or add an alias to ~/.zshrc:"
say "  alias claude-hy='CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR claude'"
say ""
say "Run 'npm run setup-profile' again after changing the plugin (it updates the installed copy)."
