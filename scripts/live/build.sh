#!/usr/bin/env bash
# Packs the repository into release tarballs and builds the live images (D-115):
#   JEV_COPS_LIVE=1 scripts/live/build.sh [claude-code|codex|opencode|pi ...]
# (default: all four), plus the base, fake-API and syslog images. Every image is labelled
# jev-cops.live=1 and named jev-cops-live-*:local. Network is used only here, by
# `docker build` (packages); the containers run on an internal network.
# Env: JEV_COPS_LIVE_PLATFORM (e.g. linux/amd64; default the Docker host's).
set -euo pipefail
# shellcheck source=scripts/live/lib.sh
source "$(dirname "$0")/lib.sh"
live_gate

harnesses=("$@")
[ ${#harnesses[@]} -eq 0 ] && harnesses=("${LIVE_HARNESSES[@]}")
mkdir -p "$LIVE_WORK/logs"
platform=()
[ -n "${JEV_COPS_LIVE_PLATFORM:-}" ] && platform=(--platform "$JEV_COPS_LIVE_PLATFORM")

build() { # name dockerfile context [extra args...]
  local name=$1 file=$2 ctx=$3
  shift 3
  echo "building jev-cops-live-$name:local"
  if ! docker build "${platform[@]}" --label "$LIVE_LABEL" -t "jev-cops-live-$name:local" \
    -f "$file" "$@" "$ctx" > "$LIVE_WORK/logs/build-$name.log" 2>&1; then
    tail -30 "$LIVE_WORK/logs/build-$name.log" >&2
    echo "build of $name failed (full log: $LIVE_WORK/logs/build-$name.log)" >&2
    exit 1
  fi
}

echo "packing the repository into $LIVE_WORK/pack"
rm -rf "$LIVE_WORK/pack"
bun "$LIVE_REPO/scripts/live/pack.ts" "$LIVE_WORK/pack"

build base "$LIVE_REPO/docker/base.Dockerfile" "$LIVE_REPO/docker"
build fake-api "$LIVE_REPO/docker/fake-api.Dockerfile" "$LIVE_REPO/scripts/live"
build syslog "$LIVE_REPO/docker/syslog.Dockerfile" "$LIVE_REPO/docker"
for h in "${harnesses[@]}"; do
  build "$h" "$LIVE_REPO/docker/$h.Dockerfile" "$LIVE_REPO/docker" \
    --build-context "tarballs=$LIVE_WORK/pack/tarballs"
done

echo "images:"
for h in "${harnesses[@]}"; do
  version=$(docker run --rm --network none --label "$LIVE_LABEL" "jev-cops-live-$h:local" \
    bash -c 'echo "$(cat /opt/jev-cops-live/harness-version) · jev-cops $(cops --version)"')
  echo "  jev-cops-live-$h:local  $version"
done
