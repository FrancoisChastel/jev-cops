# syntax=docker/dockerfile:1.7
# jev-cops live tests: the base every harness image starts from (docs/live-testing.md).
# Node 22 (the harness CLIs install with npm), Bun (jev-cops runs on Bun, D-007), git,
# tmux (interactive sessions), procps (/bin/ps: the Claude Code hook reads its parent,
# D-094), python3 (the interpreter scenarios) and a non-root user `dev`. Multi-arch
# (linux/arm64, linux/amd64): both base images are pinned by their index digest.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG BUN_IMAGE=oven/bun:1.3.13-debian@sha256:e95356cb8e1de62ad69ab3bd3584ba947013d27650a226804d2fc0af4e17dac2

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-base"
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps python3 tini tmux \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && useradd --create-home --uid 10001 --shell /bin/bash dev \
  && mkdir -p /opt/jev-cops-live && chown dev:dev /opt/jev-cops-live
USER dev
WORKDIR /home/dev
# Everything a user installs lands in their home: Bun globals, npm globals.
ENV HOME=/home/dev \
    BUN_INSTALL=/home/dev/.bun \
    NPM_CONFIG_PREFIX=/home/dev/.npm-global \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PATH=/home/dev/.bun/bin:/home/dev/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    TERM=xterm-256color
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
