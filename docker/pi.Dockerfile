# syntax=docker/dockerfile:1.7
# jev-cops live tests: Pi + jev-cops (docs/live-testing.md).
# Pi from its official npm package, `npm install -g --ignore-scripts
# @earendil-works/pi-coding-agent` (its README and docs/quickstart.md; the old
# `@mariozechner/pi-coding-agent` is deprecated in its favour), then jev-cops from the
# local tarballs. `cops install pi` runs at test time, in the container.
# Build: scripts/live/build.sh pi
ARG BASE_IMAGE=jev-cops-live-base:local
FROM ${BASE_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-pi"
ARG PI_VERSION=0.99.2
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && pi --version | tee /opt/jev-cops-live/harness-version
COPY --chown=dev:dev files/install-jev-cops.sh /opt/jev-cops-live/install-jev-cops.sh
COPY --from=tarballs --chown=dev:dev . /opt/jev-cops-live/tarballs/
RUN bash /opt/jev-cops-live/install-jev-cops.sh
COPY --chown=dev:dev files/live/ /opt/jev-cops-live/bin/
