# shellcheck shell=bash
# The e2e suite's step recorder and container helpers (sourced by scripts/live/e2e.sh after
# lib.sh). A step is `begin <id> <title>`, then expectations, then `end`. Every command an
# expectation runs is written to the step's evidence file with its output and exit code;
# each expectation adds one `PASS <what>` / `FAIL <what>` / `SKIP <what>` line. Nothing
# here exits on a failed expectation: the suite always runs to the end and reports.

# shellcheck disable=SC2034 # read by e2e.sh and the phase files
BIN=/opt/jev-cops-live/bin
STEP=""
TITLE=""
EVID=/dev/null
STEP_FAILED=0
FAILED_STEPS=0

begin() { # id title
  STEP=$1
  TITLE=$2
  EVID=$RUN/steps/$1.txt
  STEP_FAILED=0
  : > "$EVID"
  printf '\n== %s %s\n' "$1" "$2"
}

note() { printf '%s\n' "$*" >> "$EVID"; }

# Runs a command, records it with its output; returns its exit code.
record() {
  printf '$ %s\n' "$*" >> "$EVID"
  local rc=0
  "$@" >> "$EVID" 2>&1 || rc=$?
  printf '(exit %s)\n' "$rc" >> "$EVID"
  return "$rc"
}

# Records a command whose outcome is not an expectation (never fails the suite).
run() { record "$@" || true; }

pass() { printf 'PASS %s\n' "$*" >> "$EVID"; printf '   PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >> "$EVID"; printf '   FAIL %s\n' "$*"; STEP_FAILED=1; }
skip() { printf 'SKIP %s\n' "$*" >> "$EVID"; printf '   SKIP %s\n' "$*"; }

expect() { # what cmd...
  local what=$1
  shift
  if record "$@"; then pass "$what"; else fail "$what"; fi
}

expect_not() { # what cmd...
  local what=$1
  shift
  if record "$@"; then fail "$what"; else pass "$what"; fi
}

end() {
  local status=PASS
  if [ "$STEP_FAILED" = 1 ]; then
    status=FAIL
    FAILED_STEPS=$((FAILED_STEPS + 1))
  elif ! grep -q '^PASS ' "$EVID" && grep -q '^SKIP ' "$EVID"; then
    status=SKIP
  fi
  printf '%s\t%s\t%s\n' "$STEP" "$status" "$TITLE" >> "$RUN/steps.tsv"
  printf '   => %s\n' "$status"
}

meta() { printf '%s: %s\n' "$1" "$2" >> "$RUN/meta.txt"; }

# In-container commands (as dev, from its home).
cc() { live_exec claude-code "$@"; }
ccsh() { live_sh claude-code "$1"; }
pie() { live_exec pi "$@"; }
pish() { live_sh pi "$1"; }

check() { bun "$LIVE_REPO/scripts/live/check.ts" "$@"; }

A=$RUN/artifacts

# Fresh copies of the logs the checks read: the fake API's request log and raw bodies,
# and the audit log of a harness container.
pull_api() {
  live_cp_out fake-api /var/log/fake-api/requests.jsonl "$A/requests.jsonl"
  rm -rf "$A/bodies"
  live_cp_out fake-api /var/log/fake-api/bodies "$A/bodies"
}

pull_audit() { # service
  live_cp_out "$1" /home/dev/.jev-cops/audit.jsonl "$A/$1-audit.jsonl"
}

pull() { # service
  pull_api
  pull_audit "$1"
}

# The request log lines after line N (a harness's own requests), into a file.
requests_since() { # line-count out-file
  tail -n +"$(($1 + 1))" "$A/requests.jsonl" > "$2"
}

# Succeeds when one line of the file holds every fixed string; prints those lines, cut.
line_with() { # file string...
  local file=$1
  shift
  local lines
  lines=$(cat "$file")
  for s in "$@"; do lines=$(printf '%s\n' "$lines" | grep -F -- "$s") || return 1; done
  printf '%s\n' "$lines" | cut -c1-400
}

requests_count() {
  pull_api
  wc -l < "$A/requests.jsonl" | tr -d ' '
}

# The first event id of a judged call (for `cops explain`).
event_of() { # audit tool needle [verdict]
  check judge "$@" | head -1 | awk '{print $3}'
}

# A Claude Code session id from a headless run's stream-json transcript.
claude_session() { # out-name
  ccsh "grep -o '\"session_id\":\"[^\"]*\"' ~/live/out/$1/transcript.jsonl | head -1 | cut -d'\"' -f4"
}
