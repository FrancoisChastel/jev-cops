# syntax=docker/dockerfile:1.7
# jev-cops live tests: Codex CLI + jev-cops (docs/live-testing.md).
# Codex from its official npm package (`npm install -g @openai/codex`, the Codex README;
# the platform binary comes as an optional dependency), then jev-cops from the local
# tarballs. The Codex adapter does not exist yet (PLAN-M3): `cops install codex` is not run.
# Build: scripts/live/build.sh codex
ARG BASE_IMAGE=jev-cops-live-base:local
FROM ${BASE_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-codex"
ARG CODEX_VERSION=0.159.2
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && codex --version | tee /opt/jev-cops-live/harness-version
COPY --chown=dev:dev files/install-jev-cops.sh /opt/jev-cops-live/install-jev-cops.sh
COPY --from=tarballs --chown=dev:dev . /opt/jev-cops-live/tarballs/
RUN bash /opt/jev-cops-live/install-jev-cops.sh
COPY --chown=dev:dev files/live/ /opt/jev-cops-live/bin/
