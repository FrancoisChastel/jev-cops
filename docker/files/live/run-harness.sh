#!/bin/bash
# Runs one headless prompt through a real harness in this container, from the live repo,
# and keeps its output: <out>/transcript.jsonl (the harness's JSON event stream),
# <out>/stderr.txt, <out>/exit-code. Never fails on the harness's own exit code.
#   run-harness.sh claude-code|pi|codex|opencode <out-dir> <prompt> [harness args...]
set -euo pipefail

harness=${1:?usage: run-harness.sh <harness> <out-dir> <prompt> [args...]}
out=${2:?out dir}
prompt=${3:?prompt}
shift 3
mkdir -p "$out"
cd "$HOME/work/repo"
limit=${LIVE_TIMEOUT:-180}

case "$harness" in
  claude-code)
    argv=(claude -p "$prompt" --output-format stream-json --verbose "$@")
    ;;
  pi)
    # LIVE_PI_SESSION=<file>: keep the session there (a later run continues it).
    session=(--no-session)
    [ -n "${LIVE_PI_SESSION:-}" ] && session=(--session "$LIVE_PI_SESSION")
    argv=(pi -p "${session[@]}" --mode json --provider fake --model fake-model "$@" "$prompt")
    ;;
  codex)
    argv=(codex exec --json --skip-git-repo-check -C "$HOME/work/repo" "$@" "$prompt")
    ;;
  opencode)
    argv=(opencode run --format json "$@" "$prompt")
    ;;
  *)
    echo "run-harness.sh: unknown harness $harness" >&2
    exit 2
    ;;
esac

printf '%q ' "${argv[@]}" > "$out/argv.txt"
echo >> "$out/argv.txt"
set +e
timeout "$limit" "${argv[@]}" > "$out/transcript.jsonl" 2> "$out/stderr.txt" < /dev/null
echo $? > "$out/exit-code"
set -e
echo "$harness exited $(cat "$out/exit-code")"
