# shellcheck shell=bash
# Shared by scripts/live/{build,run,e2e}.sh (sourced, never run). Everything that runs a
# harness runs inside the jev-cops-live containers (D-115); the host only packs the repo,
# builds images, runs `docker compose`/`docker exec`/`docker cp`, and reads artifacts.

LIVE_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
LIVE_COMPOSE_FILE=$LIVE_REPO/docker/compose.live.yml
LIVE_PROJECT=jev-cops-live
# shellcheck disable=SC2034 # used by the scripts that source this file
LIVE_LABEL=jev-cops.live=1
# shellcheck disable=SC2034
LIVE_HARNESSES=(claude-code codex opencode pi)
# Host scratch space (tarballs, build logs, raw artifacts): never a harness config dir.
LIVE_WORK=${JEV_COPS_LIVE_WORK:-${TMPDIR:-/tmp}/jev-cops-live}
LIVE_WORK=${LIVE_WORK%/}

live_gate() {
  if [ "${JEV_COPS_LIVE:-}" != 1 ]; then
    echo "refusing to run: live tests start real harnesses (in Docker only). Set JEV_COPS_LIVE=1." >&2
    exit 2
  fi
  command -v docker > /dev/null || { echo "docker is required" >&2; exit 2; }
  command -v bun > /dev/null || { echo "bun is required (to pack the repo)" >&2; exit 2; }
}

live_compose() {
  docker compose -p "$LIVE_PROJECT" -f "$LIVE_COMPOSE_FILE" "$@"
}

# Runs a command inside a service container as `dev`, from its home.
live_exec() { # service cmd...
  local svc=$1
  shift
  docker exec -u dev -w /home/dev "$LIVE_PROJECT-$svc-1" "$@"
}

# Same, with bash -lc (for pipes and globs inside the container).
live_sh() { # service script
  live_exec "$1" bash -c "$2"
}

# Copies a file or directory out of a container into a host path.
live_cp_out() { # service container-path host-path
  docker cp "$LIVE_PROJECT-$1-1:$2" "$3" > /dev/null
}

# Copies a host file into a container (owned by dev).
live_cp_in() { # host-path service container-path
  docker cp "$1" "$LIVE_PROJECT-$2-1:$3" > /dev/null
  docker exec -u root "$LIVE_PROJECT-$2-1" chown -R dev:dev "$3"
}

# Rewrites what could identify the host out of an artifact tree: the host's home and the
# repository path. Container paths (/home/dev/...) and fixed hostnames stay.
live_redact() { # dir
  local f
  while IFS= read -r -d '' f; do
    sed -i.bak -e "s#$LIVE_REPO#<repo>#g" -e "s#$HOME#<host-home>#g" -e "s#$LIVE_WORK#<work>#g" "$f"
    rm -f "$f.bak"
  done < <(find "$1" -type f -print0)
}

# Tears down only what this project created (label jev-cops.live=1, project jev-cops-live).
live_down() {
  live_compose down -v --remove-orphans > /dev/null 2>&1 || true
}
