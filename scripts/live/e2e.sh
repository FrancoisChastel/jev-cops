#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted scripts run inside the containers: they expand there
# The full end-to-end suite, in Docker only (D-115): JEV_COPS_LIVE=1 scripts/live/e2e.sh
#
# Packs the repository into release tarballs, builds the images, starts the stack on an
# internal network (fake model API, rsyslog over TLS, one container per harness), then runs
# the product the way a user does: install from the tarballs, keygen, copsd with signed
# and forwarded audit, cops install/doctor/uninstall, real Claude Code and Pi sessions for
# every verdict, the audit trail checks, the OpenShell compiler, and the Codex/OpenCode
# round trips. Writes docs/captures/live/e2e-report.md and docs/captures/live/e2e/
# (evidence per step and the redacted artifacts); raw artifacts stay in $JEV_COPS_LIVE_WORK.
#
# Env: JEV_COPS_LIVE_NO_BUILD=1 reuses the images; JEV_COPS_LIVE_KEEP=1 leaves the stack up.
# A failed expectation never stops the run; the exit code is 1 when any step failed.
set -euo pipefail
# shellcheck source=scripts/live/lib.sh
source "$(dirname "$0")/lib.sh"
live_gate

RUN=$LIVE_WORK/e2e-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$RUN/steps" "$RUN/artifacts"
: > "$RUN/steps.tsv"
# shellcheck source=scripts/live/e2e-lib.sh
source "$LIVE_REPO/scripts/live/e2e-lib.sh"
# shellcheck source=scripts/live/e2e-claude.sh
source "$LIVE_REPO/scripts/live/e2e-claude.sh"
# shellcheck source=scripts/live/e2e-pi.sh
source "$LIVE_REPO/scripts/live/e2e-pi.sh"
# shellcheck source=scripts/live/e2e-audit.sh
source "$LIVE_REPO/scripts/live/e2e-audit.sh"
echo "e2e run: $RUN"
MANIFEST=$LIVE_WORK/pack/tarballs/manifest.json

phase_setup() {
  begin 0.1 "pack the repository (release tarballs) and build the images"
  if [ "${JEV_COPS_LIVE_NO_BUILD:-}" = 1 ]; then
    skip "build skipped (JEV_COPS_LIVE_NO_BUILD=1): images from an earlier build"
  else
    expect "scripts/live/build.sh packs and builds every image" "$LIVE_REPO/scripts/live/build.sh"
  fi
  run cat "$MANIFEST"
  expect "11 tarballs packed, @jev-cops/scanner and @jev-cops/openshell included" \
    bash -c "test \$(grep -c '\\.tgz\"' '$MANIFEST') -eq 11 && grep -q scanner '$MANIFEST' && grep -q openshell '$MANIFEST'"
  run docker image ls --filter "label=$LIVE_LABEL" --format '{{.Repository}}:{{.Tag}} {{.Size}}'
  end

  begin 0.2 "start the stack: fake API, rsyslog (TLS), Claude Code, Pi, Codex, OpenCode"
  live_down
  expect "docker compose up" live_compose up -d fake-api syslog claude-code pi codex opencode
  run live_compose ps --format '{{.Name}} {{.Status}}'
  end

  begin 0.3 "isolation: internal network, no host mount, dummy keys only"
  expect "the network is internal (no route out)" \
    bash -c "docker network inspect ${LIVE_PROJECT}_live --format '{{.Internal}}' | grep -qx true"
  local c
  for c in fake-api syslog claude-code pi codex opencode; do
    expect "$c mounts no host path" bash -c "docker inspect $LIVE_PROJECT-$c-1 --format '{{range .Mounts}}{{.Type}}:{{.Name}} {{end}}' | tee /dev/stderr | grep -vq bind"
  done
  expect_not "no DNS for api.anthropic.com from the Claude Code container" cc getent hosts api.anthropic.com
  expect_not "no route to a public address (1.1.1.1:443)" cc curl -sS --max-time 5 https://1.1.1.1
  expect "the fake API answers on the internal network" cc curl -sf http://fake-api.live.internal:8080/health
  expect "Claude Code's key is the dummy" ccsh 'test "$ANTHROPIC_API_KEY" = dummy-jev-cops-live-key-not-a-real-credential-0000'
  end
}

phase_install() {
  local version c
  version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$MANIFEST")
  meta "jev-cops" "$version (packed from $(git -C "$LIVE_REPO" rev-parse --short HEAD))"
  for c in claude-code pi codex opencode; do
    meta "$c image" "$(live_exec "$c" cat /opt/jev-cops-live/harness-version)"
  done
  begin 1.1 "installed from the tarballs: versions and bins"
  expect "cops --version prints $version" ccsh "cops --version | grep -qx '$version'"
  expect "copsd --help names $version" ccsh "copsd --help | head -1 | grep -F 'copsd $version'"
  expect "cops-hook --version prints $version" ccsh "cops-hook --version | grep -qx '$version'"
  expect "cops, copsd and cops-hook are on PATH (bun add -g)" ccsh 'command -v cops copsd cops-hook'
  run ccsh 'cd ~/.bun/install/global/node_modules && for p in jev-cops @jev-cops/*; do printf "%s %s\n" "$p" "$(grep -m1 "\"version\"" "$p/package.json" | tr -d " ,\"" | cut -d: -f2)"; done'
  note "@jev-cops/scanner is packed but not installed: nothing installed imports it until the daemon wires it in (PLAN-SETUP S2; pack-lib NOT_IN_META)."
  end

  begin 1.2 "cops --help, cops help, and every command's --help"
  expect "cops --help" cc cops --help
  expect "cops help" cc cops help
  for c in test explain replay budget install doctor keygen audit openshell service; do
    expect "cops $c --help" cc cops "$c" --help
    expect "cops help $c" cc cops help "$c"
  done
  expect "cops hook --help prints help and exits 2 (a hook exiting 0 would let a call through)" \
    ccsh 'cops hook --help; test $? -eq 2'
  end
}

phase_daemon() {
  begin 2.1 "cops keygen: the Ed25519 audit signing key"
  expect "prep the Claude Code world" cc "$BIN/prep-world.sh" claude-code
  expect "cops keygen" cc cops keygen
  expect "the private key is 0600" ccsh 'stat -c "%a %n" ~/.jev-cops/keys/audit-ed25519.key | grep "^600 "'
  expect "the public key exists" ccsh 'test -s ~/.config/jev-cops/audit-ed25519.pub'
  end

  begin 2.2 "copsd --enforce, audit forwarded over TLS to rsyslog; /v1/health on both sockets"
  expect "copsd starts with [audit.forward] syslog" cc "$BIN/copsd.sh" start --forward
  run ccsh 'cat ~/.config/jev-cops/cops.toml'
  expect "agent socket /v1/health" ccsh 'curl -sf --unix-socket ~/.jev-cops/copsd.sock http://localhost/v1/health | tee ~/live/health.json'
  expect "admin socket /v1/health" ccsh 'curl -sf --unix-socket ~/.jev-cops/copsd-admin.sock http://localhost/v1/health > /dev/null'
  expect "enforcing, 6 starter policies from the installed package" ccsh 'grep -q "\"enforcement\":\"enforce\"" ~/live/health.json && test "$(grep -o "\"name\":" ~/live/health.json | wc -l)" -eq 6'
  expect "the forwarder is connected to syslog.live.internal over TLS" ccsh 'grep -q "\"kind\":\"syslog\",\"connected\":true" ~/live/health.json'
  expect "the signing key is in force" ccsh 'grep -q "\"in_force\":\"" ~/live/health.json'
  end

  begin 2.3 "cops service (dry run in the container; never on the host)"
  expect "cops service install --dry-run --platform linux prints a systemd user unit" \
    ccsh 'cops service install --dry-run --platform linux | tee /dev/stderr | grep -q "ExecStart="'
  end
}

phase_final() {
  begin 9.1 "no human-only text reached any model in the whole run"
  pull_api
  expect "no score, confirm view or explain id in any of the run's request bodies" check leaks "$A/bodies"
  run bash -c "wc -l < '$A/requests.jsonl'"
  end
}

collect() {
  local out=$LIVE_REPO/docs/captures/live/e2e h
  pull_api
  pull_audit claude-code || true
  pull_audit pi || true
  for h in claude-code pi codex opencode; do
    mkdir -p "$A/$h"
    live_cp_out "$h" /home/dev/live/out "$A/$h/out" || true
  done
  for f in install.out doctor.out uninstall.out settings.pre-install.json settings.post-install.json cops.pre-install.toml replay.out openshell-dry-run.out openshell-policy.yaml; do
    live_cp_out claude-code "/home/dev/live/$f" "$A/claude-code/$f" 2> /dev/null || true
  done
  live_cp_out pi /home/dev/live/doctor-pi.out "$A/pi/doctor-pi.out" 2> /dev/null || true
  rm -rf "$out"
  mkdir -p "$out/steps" "$out/fake-api" "$out/syslog"
  cp "$RUN"/steps/*.txt "$out/steps/"
  check digest "$A/requests.jsonl" > "$out/fake-api/requests.digest.jsonl"
  cp "$A/syslog-copsd.log" "$out/syslog/copsd.log" 2> /dev/null || true
  for h in claude-code pi codex opencode; do
    mkdir -p "$out/$h"
    cp -R "$A/$h/." "$out/$h/"
    [ -f "$A/$h-audit.jsonl" ] && cp "$A/$h-audit.jsonl" "$out/$h/audit.jsonl"
  done
  cp "$A/claude-code-rewrite-audit.jsonl" "$out/claude-code/rewrite-audit.jsonl" 2> /dev/null || true
  cp "$A/pi-rewrite-audit.jsonl" "$out/pi/rewrite-audit.jsonl" 2> /dev/null || true
  live_redact "$out"
  cp "$RUN/meta.txt" "$RUN/meta.full.txt"
  bun "$LIVE_REPO/scripts/live/report.ts" "$RUN" > "$LIVE_REPO/docs/captures/live/e2e-report.md"
  live_redact "$LIVE_REPO/docs/captures/live/e2e-report.md"
}

# From here on a failing command is evidence, not a reason to stop: steps record it.
set +e
meta "date" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
meta "docker" "$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
phase_setup
phase_install
phase_daemon
phase_claude
phase_pi
phase_audit
phase_openshell
phase_uninstall
roundtrip 8.1 codex /v1/responses
roundtrip 8.2 opencode /v1/chat/completions
phase_final
collect
[ "${JEV_COPS_LIVE_KEEP:-}" = 1 ] || live_down
echo
echo "report: docs/captures/live/e2e-report.md · raw artifacts: $RUN"
echo "failed steps: $FAILED_STEPS"
[ "$FAILED_STEPS" -eq 0 ]
