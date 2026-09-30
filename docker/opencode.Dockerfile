# syntax=docker/dockerfile:1.7
# jev-cops live tests: OpenCode + jev-cops (docs/live-testing.md).
# OpenCode from its official npm package (`npm i -g opencode-ai`, opencode.ai/docs; its
# postinstall links the platform binary), then jev-cops from the local tarballs. The
# OpenCode adapter does not exist yet (PLAN-M3): `cops install opencode` is not run.
# Build: scripts/live/build.sh opencode
ARG BASE_IMAGE=jev-cops-live-base:local
FROM ${BASE_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-opencode"
ARG OPENCODE_VERSION=1.18.33
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && opencode --version | tee /opt/jev-cops-live/harness-version
COPY --chown=dev:dev files/install-jev-cops.sh /opt/jev-cops-live/install-jev-cops.sh
COPY --from=tarballs --chown=dev:dev . /opt/jev-cops-live/tarballs/
RUN bash /opt/jev-cops-live/install-jev-cops.sh
COPY --chown=dev:dev files/live/ /opt/jev-cops-live/bin/
