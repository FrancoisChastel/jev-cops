#!/bin/bash
# Starts or stops copsd in the container (as `dev`), the way a user runs it by hand.
#   copsd.sh start [--forward]   write ~/.config/jev-cops/cops.toml (with --forward:
#                                [audit.forward] syslog over TLS to the receiver, pinning
#                                its throwaway CA), start `copsd --enforce`, wait for
#                                /v1/health on both sockets
#   copsd.sh stop                SIGTERM, wait for the clean exit (shutdown checkpoint)
#   copsd.sh start-rewrite       a second copsd with only the test policy pin-rm
#                                (sockets and audit under ~/live/rewrite), for the rewrite
#                                scenarios; stop-rewrite stops it
set -euo pipefail

cmd=${1:?usage: copsd.sh start [--forward] | stop | start-rewrite | stop-rewrite}
live=$HOME/live
mkdir -p "$live" "$HOME/.config/jev-cops" "$HOME/.jev-cops"
chmod 700 "$HOME/.jev-cops"

health() { # socket
  curl -sf --max-time 2 --unix-socket "$1" http://localhost/v1/health
}

wait_health() { # socket log
  for _ in $(seq 1 100); do
    if [ -S "$1" ] && health "$1" > /dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "copsd did not become healthy on $1; its log:" >&2
  cat "$2" >&2
  return 1
}

stop_pid() { # pidfile
  [ -f "$1" ] || return 0
  local pid
  pid=$(cat "$1")
  if kill -0 "$pid" 2> /dev/null; then
    kill -TERM "$pid"
    for _ in $(seq 1 100); do kill -0 "$pid" 2> /dev/null || break; sleep 0.1; done
  fi
  rm -f "$1"
}

write_config() { # forward?
  local cfg=$HOME/.config/jev-cops/cops.toml
  {
    echo "[enforcement]"
    echo 'mode = "enforce"'
    if [ "$1" = yes ]; then
      echo
      echo "[audit.forward]"
      echo 'kind = "syslog"'
      echo 'target = "syslog.live.internal:6514"'
      echo 'ca_file = "/certs/ca.pem"'
      echo 'app_name = "copsd"'
    fi
  } > "$cfg.tmp"
  # `cops install claude-code` adds [daemon] hook_binary to this file: keep that line.
  if [ -f "$cfg" ] && grep -q '^hook_binary' "$cfg"; then
    { echo "[daemon]"; grep '^hook_binary' "$cfg"; echo; cat "$cfg.tmp"; } > "$cfg.new"
    mv "$cfg.new" "$cfg.tmp"
  fi
  mv "$cfg.tmp" "$cfg"
}

case "$cmd" in
  start)
    forward=no
    [ "${2:-}" = --forward ] && forward=yes
    if [ "$forward" = yes ]; then
      for _ in $(seq 1 50); do [ -s /certs/ca.pem ] && break; sleep 0.2; done
      [ -s /certs/ca.pem ] || { echo "no /certs/ca.pem from the syslog receiver" >&2; exit 1; }
    fi
    write_config "$forward"
    stop_pid "$live/copsd.pid"
    nohup copsd --enforce > "$live/copsd.out" 2> "$live/copsd.log" < /dev/null &
    echo $! > "$live/copsd.pid"
    wait_health "$HOME/.jev-cops/copsd.sock" "$live/copsd.log"
    wait_health "$HOME/.jev-cops/copsd-admin.sock" "$live/copsd.log"
    grep -m1 '^copsd listening' "$live/copsd.log" || true
    ;;
  stop)
    stop_pid "$live/copsd.pid"
    ;;
  start-rewrite)
    r=$live/rewrite
    mkdir -p "$r/policies" "$r/run"
    chmod 700 "$r/run"
    cat > "$r/policies/pin-rm.ts" <<'EOF'
// Test-only (live rewrite scenario): pins a relative `rm` to its resolved absolute paths.
export default {
  name: "pin-rm", version: 1, owner: "live-tests",
  when: (e) => e.commands.some((c) => c.argv[0] === "rm" && c.argv.some((a) => a.startsWith("./"))),
  decide: () => "rewrite",
  rewrite: (e) => ({ command: "rm -rf -- " + e.paths.join(" ") }),
  reason: "Pinned the resolved path.",
};
EOF
    cat > "$r/cops.toml" <<EOF
[daemon]
socket = "$r/run/copsd.sock"
admin_socket = "$r/run/admin.sock"
[policies]
dir = "$r/policies"
[audit]
path = "$r/audit.jsonl"
[store]
path = "$r/cops.sqlite"
[enforcement]
mode = "enforce"
EOF
    stop_pid "$r/copsd.pid"
    # Its own HOME: the user's cops.toml (and its audit forwarding) must not apply to it.
    mkdir -p "$r/home"
    HOME=$r/home nohup copsd --enforce --config "$r/cops.toml" \
      > "$r/copsd.out" 2> "$r/copsd.log" < /dev/null &
    echo $! > "$r/copsd.pid"
    wait_health "$r/run/copsd.sock" "$r/copsd.log"
    grep -m1 '^copsd listening' "$r/copsd.log" || true
    ;;
  stop-rewrite)
    stop_pid "$live/rewrite/copsd.pid"
    ;;
  *)
    echo "copsd.sh: unknown command $cmd" >&2
    exit 2
    ;;
esac
