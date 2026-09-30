# syntax=docker/dockerfile:1.7
# jev-cops live tests: Claude Code + jev-cops (docs/live-testing.md).
# Claude Code from its official npm package (code.claude.com/docs/en/setup, "Install with
# npm": the same native binary as the install script), then jev-cops from the tarballs
# packed from this repository (named build context `tarballs`), as a user would.
# Build: scripts/live/build.sh claude-code
ARG BASE_IMAGE=jev-cops-live-base:local
FROM ${BASE_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-claude-code"
ARG CLAUDE_CODE_VERSION=2.1.286
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && claude --version | tee /opt/jev-cops-live/harness-version
COPY --chown=dev:dev files/install-jev-cops.sh /opt/jev-cops-live/install-jev-cops.sh
COPY --from=tarballs --chown=dev:dev . /opt/jev-cops-live/tarballs/
RUN bash /opt/jev-cops-live/install-jev-cops.sh
COPY --chown=dev:dev files/live/ /opt/jev-cops-live/bin/
