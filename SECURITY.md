# Security policy

Jevdict is a detection-and-response layer for coding agents. A bypass of its judge is
a security issue, even though Jevdict is explicitly **not** the last line of defence
(see "What it is not" in `docs/SPEC.md`): hard guarantees belong to a kernel-enforced
sandbox such as OpenShell.

## Reporting

Email **francois@chastel.co** with a description and, if possible, a reproducing event
JSON or transcript. Please do not open a public issue for a bypass. You will get an
acknowledgement within 72 hours.

## In scope

- Any way an agent tool call reaches execution with a verdict lower than the policy set
  and the deterministic floor require (including timeouts, malformed events, parser
  confusion, encoding tricks, taint laundering).
- Any way a model answer lowers a verdict below `floor − 0.2`.
- Any way `detail` (human-only text) reaches the harness or the agent.
- Audit log tampering that is not detected by the hash chain.

## Out of scope

- Gaps in the harnesses themselves that `jevdict doctor` already prints as known
  (listed in `docs/adapters.md`). Please still tell us if you find a new one.
- Anything that requires `--dangerously-skip-permissions` or equivalent; that is
  OpenShell's territory.

## Supported versions

Pre-1.0: only the `master` branch receives fixes.
