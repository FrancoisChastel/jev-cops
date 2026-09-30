#!/usr/bin/env bash
# One live scenario in Docker (D-115), captured into docs/captures/live/<harness>-<scenario>/:
#   JEV_COPS_LIVE=1 scripts/live/run.sh <harness> <scenario>
#
#   claude-code  benign-ls | force-push-main-headless | write-settings-kill
#   pi           fake-api-roundtrip | force-push-main-headless
#   codex        fake-api-roundtrip      (no adapter yet: the harness and the fake API only)
#   opencode     fake-api-roundtrip      (no adapter yet: the harness and the fake API only)
#
# Builds that harness's image (JEV_COPS_LIVE_NO_BUILD=1 reuses it), starts the fake API and
# the harness container on the internal network, starts copsd --enforce on the installed
# starter policies and runs `cops install <harness>` (Claude Code, Pi), drives the harness
# headlessly, then copies out: transcript(s), the audit log, the fake API request log (and
# its digest: what the model read), redacted (no host path; hostnames are fixed by compose).
set -euo pipefail
# shellcheck source=scripts/live/lib.sh
source "$(dirname "$0")/lib.sh"
live_gate

harness=${1:-}
scenario=${2:-}
case "$harness/$scenario" in
  claude-code/benign-ls | claude-code/force-push-main-headless | claude-code/write-settings-kill) ;;
  pi/fake-api-roundtrip | pi/force-push-main-headless) ;;
  codex/fake-api-roundtrip | opencode/fake-api-roundtrip) ;;
  *)
    sed -n '2,12p' "$0" >&2
    exit 2
    ;;
esac

BIN=/opt/jev-cops-live/bin
OUT=$LIVE_REPO/docs/captures/live/$harness-$scenario
RAW=$LIVE_WORK/run-$harness-$scenario
rm -rf "$RAW"
mkdir -p "$RAW"
x() { live_exec "$harness" "$@"; }

[ "${JEV_COPS_LIVE_NO_BUILD:-}" = 1 ] || "$LIVE_REPO/scripts/live/build.sh" "$harness"
live_down
trap live_down EXIT
live_compose up -d fake-api "$harness"
x "$BIN/prep-world.sh" "$harness"
if [ "$harness" = claude-code ] || [ "$harness" = pi ]; then
  x "$BIN/copsd.sh" start
  x cops install "$harness" > "$RAW/install.out" 2>&1
fi

prompt() { # out-name prompt [args...]
  x "$BIN/run-harness.sh" "$harness" "/home/dev/live/out/$1" "${@:2}"
}

case "$scenario" in
  benign-ls | fake-api-roundtrip) prompt run "SCENARIO:ls list the files here" ;;
  force-push-main-headless) prompt run "SCENARIO:push-main sync my branch" ;;
  write-settings-kill)
    prompt run "SCENARIO:write-settings tidy the project settings" \
      --permission-mode manual --allowedTools Write
    sid=$(live_sh claude-code "grep -o '\"session_id\":\"[^\"]*\"' ~/live/out/run/transcript.jsonl | head -1 | cut -d'\"' -f4")
    prompt next "SCENARIO:echo are you still there?" --resume "$sid"
    ;;
esac

# Collect.
live_cp_out fake-api /var/log/fake-api/requests.jsonl "$RAW/requests.jsonl"
live_cp_out "$harness" /home/dev/live/out "$RAW/out"
live_exec "$harness" bash -c 'cat /opt/jev-cops-live/harness-version; cops --version' > "$RAW/versions.txt"
rm -rf "$OUT"
mkdir -p "$OUT"
check() { bun "$LIVE_REPO/scripts/live/check.ts" "$@"; }
for d in "$RAW"/out/*/; do
  name=$(basename "$d")
  cp "$d/transcript.jsonl" "$OUT/transcript-$name.jsonl"
  cp "$d/argv.txt" "$OUT/argv-$name.txt"
  printf 'exit %s\n' "$(cat "$d/exit-code")" >> "$OUT/argv-$name.txt"
done
cp "$RAW/requests.jsonl" "$OUT/requests.jsonl"
check digest "$RAW/requests.jsonl" > "$OUT/requests.digest.jsonl"
for s in ls push-main write-settings echo; do
  check seen "$RAW/requests.jsonl" "$s" >> "$OUT/model-saw.txt" 2> /dev/null || true
done
if [ "$harness" = claude-code ] || [ "$harness" = pi ]; then
  live_cp_out "$harness" /home/dev/.jev-cops/audit.jsonl "$OUT/audit.jsonl"
  cp "$RAW/install.out" "$OUT/install.out"
  check judge "$OUT/audit.jsonl" '*' '' > "$OUT/judged.txt" || true
fi
{
  echo "harness: $(head -1 "$RAW/versions.txt") · jev-cops $(tail -1 "$RAW/versions.txt")"
  echo "scenario: $scenario"
  echo "captured: $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/live/run.sh (Docker, internal network, fake API, dummy key)"
} > "$OUT/README.txt"
live_redact "$OUT"
echo "captured into ${OUT#"$LIVE_REPO"/}"
cat "$OUT/judged.txt" 2> /dev/null || true
cat "$OUT/model-saw.txt"
