# syntax=docker/dockerfile:1.7
# jev-cops live tests: an rsyslog receiver for the audit forwarder (RFC 5425: syslog over
# TLS, octet-counted). A throwaway CA and server certificate are generated at every start;
# only the CA certificate is shared (volume `certs`), so copsd can pin it as `ca_file`.
# Received copsd messages are written verbatim (%rawmsg%) to /var/log/remote/copsd.log,
# the off-box copy `cops audit verify --remote` reads.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
FROM ${DEBIAN_IMAGE}
LABEL jev-cops.live="1" org.opencontainers.image.title="jev-cops-live-syslog"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl rsyslog rsyslog-gnutls \
  && rm -rf /var/lib/apt/lists/*
COPY files/syslog/rsyslog.conf /etc/rsyslog.conf
COPY files/syslog/entrypoint.sh /usr/local/bin/syslog-entrypoint
RUN chmod 0755 /usr/local/bin/syslog-entrypoint && mkdir -p /var/log/remote /etc/rsyslog-tls /certs
EXPOSE 6514
ENTRYPOINT ["/usr/local/bin/syslog-entrypoint"]
