#!/bin/bash
# Generates a throwaway CA and a server certificate for syslog.live.internal, publishes the
# CA certificate in /certs (the shared volume), then runs rsyslogd in the foreground.
set -euo pipefail

tls=/etc/rsyslog-tls
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -subj "/CN=jev-cops live throwaway CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$tls/ca-key.pem" -out "$tls/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -subj "/CN=syslog.live.internal" -keyout "$tls/key.pem" -out "$tls/server.csr" 2>/dev/null
printf '%s\n' "subjectAltName=DNS:syslog.live.internal,DNS:syslog" \
  "extendedKeyUsage=serverAuth" "basicConstraints=critical,CA:FALSE" > "$tls/ext.cnf"
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.pem" -CAkey "$tls/ca-key.pem" \
  -CAcreateserial -days 2 -extfile "$tls/ext.cnf" -out "$tls/cert.pem" 2>/dev/null
umask 022
install -m 0644 "$tls/ca.pem" /certs/ca.pem
: > /var/log/remote/copsd.log
echo "syslog receiver: CA $(openssl x509 -in /certs/ca.pem -noout -fingerprint -sha256)"
exec rsyslogd -n -f /etc/rsyslog.conf
