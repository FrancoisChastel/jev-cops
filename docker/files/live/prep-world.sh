#!/bin/bash
# Prepares the container user's world for a live run (idempotent): a git repository on
# `main` with a local bare remote (a push never leaves the container), the files the
# scenarios read, and the harness's own configuration pointing at the fake model API with
# the dummy key. Runs inside a jev-cops-live-<harness> container, as `dev`.
#   prep-world.sh claude-code|codex|opencode|pi
set -euo pipefail

harness=${1:?usage: prep-world.sh <harness>}
api=${FAKE_API_URL:-http://fake-api.live.internal:8080}
key=${FAKE_API_KEY:?FAKE_API_KEY must be set (a dummy)}
work=$HOME/work
repo=$work/repo
mkdir -p "$HOME/live"

git config --global user.email live@example.invalid
git config --global user.name "jev-cops live"
git config --global init.defaultBranch main
if [ ! -d "$repo/.git" ]; then
  git init -q --bare -b main "$work/remote.git"
  git init -q -b main "$repo"
  mkdir -p "$repo/logs" "$repo/build" "$repo/.cache/build-7f3a" "$repo/auth"
  printf 'hello from the live repo\n' > "$repo/README.md"
  printf 'test("auth session", () => {});\n' > "$repo/auth/session.test.ts"
  printf 'auth.session.test.ts failed: stale fixtures in %s/.cache/build-7f3a\nremove it and retry\n' \
    "$repo" > "$repo/logs/ci-failure.txt"
  printf 'build/\n.cache/\n.env\n' > "$repo/.gitignore"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m init
  git -C "$repo" remote add origin "$work/remote.git"
  git -C "$repo" push -q -u origin main
fi
# Re-created on every run: the scenarios delete or read them.
printf 'object\n' > "$repo/build/out.o"
printf 'stale\n' > "$repo/.cache/build-7f3a/fixture.json"
printf 'API_TOKEN=live-fake-token-not-a-secret-0000\n' > "$repo/.env"

setup_claude_code() {
  local last20=${key: -20}
  cat > "$HOME/.claude.json" <<EOF
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "$(claude --version | cut -d' ' -f1)",
  "theme": "dark",
  "autoUpdates": false,
  "customApiKeyResponses": { "approved": ["$last20"], "rejected": [] },
  "projects": {
    "$repo": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true, "allowedTools": [] }
  }
}
EOF
  mkdir -p "$HOME/.claude"
  # A user's own settings before jev-cops: install must keep them, uninstall must restore them.
  if [ ! -f "$HOME/.claude/settings.json" ]; then
    printf '{\n  "theme": "dark",\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n' \
      > "$HOME/.claude/settings.json"
  fi
}

setup_pi() {
  mkdir -p "$HOME/.pi/agent"
  cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "fake": {
      "baseUrl": "$api/v1",
      "api": "openai-completions",
      "apiKey": "\$FAKE_API_KEY",
      "models": [{ "id": "fake-model", "name": "jev-cops live fake model" }]
    }
  }
}
EOF
  [ -f "$HOME/.pi/agent/settings.json" ] ||
    printf '{\n  "defaultProvider": "fake",\n  "defaultModel": "fake-model"\n}\n' > "$HOME/.pi/agent/settings.json"
}

setup_codex() {
  mkdir -p "$HOME/.codex"
  cat > "$HOME/.codex/config.toml" <<EOF
model = "gpt-5.5"
model_provider = "fake"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[model_providers.fake]
name = "jev-cops live fake"
base_url = "$api/v1"
env_key = "FAKE_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[projects."$repo"]
trust_level = "trusted"
EOF
}

setup_opencode() {
  mkdir -p "$HOME/.config/opencode"
  cat > "$HOME/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "model": "fake/fake-model",
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jev-cops live fake",
      "options": { "baseURL": "$api/v1", "apiKey": "{env:FAKE_API_KEY}" },
      "models": { "fake-model": { "name": "fake model", "tool_call": true } }
    }
  }
}
EOF
}

case "$harness" in
  claude-code) setup_claude_code ;;
  pi) setup_pi ;;
  codex) setup_codex ;;
  opencode) setup_opencode ;;
  *) echo "prep-world.sh: unknown harness $harness" >&2; exit 2 ;;
esac
echo "prep-world: $harness ready in $repo"
