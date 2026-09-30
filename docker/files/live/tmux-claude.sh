#!/bin/bash
# Drives an interactive `claude` in tmux inside this container (what a human sees is the
# pane; the hook reads a real interactive parent).
#   tmux-claude.sh start <name> [claude args]  start claude in ~/work/repo, wait for its prompt
#   tmux-claude.sh send <name> <text>          type text, then Enter
#   tmux-claude.sh keys <name> <key>...        send raw keys (Enter, Escape, 2, ...)
#   tmux-claude.sh wait <name> <regex> [secs]  wait until the pane matches (exit 1 on timeout)
#   tmux-claude.sh capture <name> <file>       save the joined pane (trailing spaces stripped)
#   tmux-claude.sh stop <name>
set -euo pipefail

cmd=${1:?usage: tmux-claude.sh start|send|keys|wait|capture|stop <name> ...}
name=${2:?session name}
sock=$HOME/live/tmux.sock
t() { tmux -S "$sock" -f /dev/null "$@"; }

pane() { t capture-pane -p -J -S -200 -t "$name" | sed -e 's/[[:space:]]*$//'; }

wait_for() { # regex secs
  local deadline=$((SECONDS + ${2:-30}))
  while [ $SECONDS -lt $deadline ]; do
    if pane | grep -Eq "$1"; then return 0; fi
    sleep 0.5
  done
  echo "tmux-claude: timed out waiting for /$1/ in $name; the pane:" >&2
  pane >&2
  return 1
}

case "$cmd" in
  start)
    shift 2
    t kill-session -t "$name" 2> /dev/null || true
    # The session keeps running after claude exits, so its last screen can be captured.
    t new-session -d -s "$name" -x 160 -y 50 -c "$HOME/work/repo" \
      "claude $(printf '%q ' "$@"); echo '[claude exited]'; sleep 3600"
    wait_for '(for shortcuts|Try "|❯)' 60
    ;;
  send)
    t send-keys -t "$name" -l "${3:?text}"
    sleep 0.3
    t send-keys -t "$name" Enter
    ;;
  keys)
    shift 2
    t send-keys -t "$name" "$@"
    ;;
  wait)
    wait_for "${3:?regex}" "${4:-60}"
    ;;
  capture)
    pane > "${3:?file}"
    ;;
  stop)
    t kill-session -t "$name" 2> /dev/null || true
    ;;
  *)
    echo "tmux-claude.sh: unknown command $cmd" >&2
    exit 2
    ;;
esac
