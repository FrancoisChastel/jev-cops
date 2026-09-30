# Audit log

The audit log is copsd's record of every judged call, observed result, anomaly, precedent
and session report (spec §Stores, T12). Owner decisions: the local append-only JSONL stays
the primary log and is shipped off the box by a pluggable forwarder, syslog first (D-103);
the daemon signs checkpoints of the hash chain with an Ed25519 key kept outside the
sandbox, and the cyber team holds the public key (D-104).

## What it guarantees

- **Hash chain.** Each line carries `seq` (from 1, +1 per line), `prev` (the previous line's
  `hash`, 64 zeros for the first) and `hash = sha256(prev + canonicalJSON(line without
  hash))`. Editing, deleting or reordering a line breaks the chain at that seq.
- **Signed checkpoints.** A `checkpoint` line signs the chain through the line before it.
  Without the private key nobody can edit, drop or recompute any line up to the last
  checkpoint, strip the checkpoints, or append more unsigned lines than the checkpoint
  interval, without `cops audit verify` failing.
- **Off-box copy.** What signatures cannot show locally — the lines after the last
  checkpoint, and a tail cut exactly at a checkpoint — shows against the forwarded copy:
  the copy can only hold what copsd wrote locally first, so a copy that goes further than
  the local log is a local truncation.
- **Live detection.** A running copsd notices a cut under it: its next line follows the
  real last line, not the file's, so the chain breaks there; with a forwarder, "the audit
  log shrank under the forwarder" is audited at once, and a cursor or file copy ahead of the
  log at boot is an `anomaly` line.

## Line format

One canonical JSON object per line (keys sorted), `kind` one of `judge`, `observe`,
`anomaly`, `precedent`, `boot`, `session`, `checkpoint`:

```json
{"at":1790769600002,"event_id":"evt_01K6DXM1ZD5V7C1Y1S4W2C0Q9T","hash":"1971e90c…0250","kind":"session","payload":{"closed":true,"report":"end"},"prev":"a8effb72…d2b1","seq":3,"session_id":"sess_01K6DXKX9Y"}
```

### Checkpoint lines

Written after every `[audit] checkpoint_every` lines (100), after the boot line, after a
root session's `end` report, after the shutdown line, and at key rotation:

```json
{"at":1790769600003,"hash":"2f768e7c…7a7f","kind":"checkpoint","payload":{"alg":"ed25519","at":1790769600003,"count":1,"every":100,"head_hash":"1971e90c…0250","head_seq":3,"key_id":"fec9306aa38d7959","prev_checkpoint":{"hash":"a8effb72…d2b1","seq":2},"reason":"session-end","sig":"VD2tdl4N…jg1BQ"},"prev":"1971e90c…0250","seq":4}
```

| Field | Meaning |
|---|---|
| `alg` | `ed25519` |
| `key_id` | first 16 hex characters of SHA-256 of the raw 32-byte public key |
| `head_seq`, `head_hash` | the line the checkpoint follows (its own `seq - 1` and `prev`) |
| `count` | lines since the previous checkpoint line (excluded), through the head |
| `every` | the daemon's interval when it signed; the unsigned tail may not exceed it |
| `prev_checkpoint` | `{seq, hash}` of the previous checkpoint line, `null` for the first |
| `reason` | `interval`, `boot`, `session-end`, `shutdown` or `rotation` |
| `at` | the line's own `at` |
| `next_key_id`, `next_public_key` | rotation only: the key that signs from the next checkpoint on (SPKI PEM) |
| `sig` | base64url Ed25519 signature |

The signed bytes are `jev-cops.audit.checkpoint/1`, a newline, then the canonical JSON of
every payload field except `sig` (so the reason and a rotation's next key are covered).

## Keys

`cops keygen` writes the private key to `[audit] key` (default
`~/.jev-cops/keys/audit-ed25519.key`, PKCS #8 PEM, 0600 in a 0700 directory; copsd refuses a
key others can read) and the public key to `[audit] public_key` (default
`~/.config/jev-cops/audit-ed25519.pub`, SPKI PEM): hand that file to the cyber team. Both
paths are in the daemon's protected paths and the private key in its private paths (D-098),
so `config-tamper` guards them; under OpenShell the sandbox has no path to them at all.

`cops keygen --rotate` leaves the next key at `<key>.next` and asks a running copsd, on its
admin socket (`POST /v1/audit/rotate`), to switch: copsd writes a `rotation` checkpoint
signed by the current key naming the new key id and public key, then signs with the new
key. Without a running copsd it switches at its next start. Verifiers trust the root public
key and follow rotations in the chain; a checkpoint signed by a key that is not in force
fails.

Without a key copsd starts with a loud warning and writes no checkpoint;
`[audit] require_signing = true` makes that fatal.

## Forwarding

```toml
[audit.forward]
kind = "syslog"                   # or "file" (a JSONL copy, e.g. on another mount)
target = "siem.example:6514"      # host:port, or a path for kind = "file"
ca_file = "/etc/jev-cops/siem-ca.pem"   # required: the receiver's certificate must chain to it
# cert_file / key_file = client certificate and key, when the receiver asks for one
# server_name = SNI and the name checked in the certificate (default: the host)
# facility = "local0"; app_name = "copsd"; enterprise_number = 32473
# max_message_bytes = 8192        # 2048 to 1048576; longer lines are split into parts
# required = false                # true: fail closed past the lag limits below
# max_lag_lines = 1000; max_lag_ms = 60000
# cursor = "~/.jev-cops/forward.cursor"   # default: next to the audit log
```

Each line is one RFC 5424 message over TLS (TLS 1.2 or later, the server always verified),
octet-counted per RFC 5425 §4.3.1 (`MSG-LEN SP SYSLOG-MSG`):

```text
627 <133>1 2026-09-30T12:00:00.002Z build-box copsd 4242 session [jevcops@32473 seq="3" prev="a8effb72…d2b1" hash="1971e90c…0250" kind="session" event_id="evt_01K6DXM1ZD5V7C1Y1S4W2C0Q9T" session_id="sess_01K6DXKX9Y"] BOM{"at":1790769600002,…,"seq":3,"session_id":"sess_01K6DXKX9Y"}
```

- PRI: `facility × 8 + severity`, severity `warning` (4) for `anomaly` lines, `notice` (5)
  otherwise. MSGID is the line's kind.
- The `jevcops@<PEN>` structured-data element carries `seq`, `prev`, `hash`, `kind` and,
  when set, `event_id`/`session_id` (capped at 128 octets; the full values are in MSG), so a
  receiver can rebuild the chain without parsing MSG. 32473 is RFC 5424's example private
  enterprise number, until the team registers one.
- MSG is a UTF-8 BOM and the canonical JSON line. A line longer than
  `max_message_bytes` becomes `n` messages with `part="i/n"` in the element, cut on
  character boundaries; `cops audit verify` reassembles them. 8192 is the size RFC 5425 says
  receivers SHOULD accept (rsyslog's default).
- Delivery is at least once. The local log is the queue: a persisted cursor marks the last
  line handed over, a restart resumes after it, a dead receiver is retried with backoff and
  caught up from the file. Syslog has no acknowledgement, so a connection lost within 2 s of
  opening counts as having delivered nothing (a TLS 1.3 receiver refusing a client
  certificate does so after the handshake), and a later loss resends the last 100 lines.
  Resent lines carry the same seq and hash; verifiers drop them.
- Forwarding never blocks judging unless `required = true`: then, once the forwarder is more
  than `max_lag_lines` lines or `max_lag_ms` behind, `/v1/judge` answers 503 `audit forwarder
  down` for the deny class (the adapters block it, T2) and still judges reads; each refusal
  is an `anomaly` line. A repo `.cops.toml` may turn `required` or `require_signing` on,
  nothing else in `[audit]`.

`/v1/health` reports `audit.head_seq`, `audit.signing` (key, key in force, interval, last
checkpoint) and `audit.forward` (connected, sent seq, lag lines and ms, last error,
required, refusing), never the target.

## Verifying

```sh
cops audit verify ~/.jev-cops/audit.jsonl --pubkey team.pub                 # chain + signatures
cops audit verify ~/.jev-cops/audit.jsonl --pubkey team.pub --remote copy   # + the off-box copy
cops doctor --audit-remote copy                                             # the same, in doctor
```

`--remote` takes our JSONL, RFC 5424 messages one per line (as a receiver writes them), or a
raw RFC 5425 capture. Every seq both hold must be the same line; a copy longer than the
local log fails ("local tail truncated after seq N", saying whether a signed checkpoint
covers the missing lines); a shorter copy is forwarding lag (a warning). Exit 0 verified
(warnings included), 1 failed or unreadable input, 2 usage; `--json` prints
`jev-cops.audit-verify/1`.
