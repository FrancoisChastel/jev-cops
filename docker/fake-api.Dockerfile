# syntax=docker/dockerfile:1.7
# jev-cops live tests: the fake model API (scripts/live/fake-api), the only "model" any
# harness container can reach. Build context: scripts/live.
ARG BUN_IMAGE=oven/bun:1.3.13-debian@sha256:e95356cb8e1de62ad69ab3bd3584ba947013d27650a226804d2fc0af4e17dac2
FROM ${BUN_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-fake-api"
COPY fake-api/ /opt/fake-api/
COPY scenarios.json /opt/fake-api/scenarios.json
RUN rm -f /opt/fake-api/*.test.ts && mkdir -p /var/log/fake-api && chown bun:bun /var/log/fake-api
USER bun
ENV FAKE_API_SCRIPT=/opt/fake-api/scenarios.json \
    FAKE_API_LOG_DIR=/var/log/fake-api \
    FAKE_API_BODIES=1 \
    FAKE_API_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --retries=15 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8080/health'); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "/opt/fake-api/main.ts"]
