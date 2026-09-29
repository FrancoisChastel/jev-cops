# Tamper tests

One file per threat in the spec's threat model (`docs/SPEC.md` §Threat model and
anti-tamper acceptance tests). Each file quotes the spec's attack and required outcome at
the top. A threat whose outcome cannot be asserted yet stays as `test.todo` named with the
required outcome, until its milestone. Do not delete or weaken one (CONTRIBUTING.md).

| # | Threat | File | Status | Milestone |
|---|---|---|---|---|
| T1 | Config tampering | `T01-config-tamper.test.ts` | todo | M1 (config-tamper policy, `ConfigChange`); M2 (OpenShell) |
| T2 | Daemon killed or unreachable | `T02-daemon-unreachable.test.ts` | live (daemon: 500 + anomaly, refused socket; Pi adapter: exec/write/other fail closed, reads fail open and warn); 1 todo | Claude Code hook: M1 |
| T3 | Hook timeout | `T03-hook-timeout.test.ts` | live (daemon: 504 "judge timeout" at the deadline; Pi adapter: blocked with "judge timeout"); 1 todo | Claude Code hook: M1 |
| T4 | Harness gap | `T04-harness-gap.test.ts` | todo | M2 (OpenShell compiler); M1/M3 installers |
| T5 | Obfuscation | `T05-obfuscation.test.ts` | live (core + policy engine: with the repo policies, `opaque-exec` holds the base64 pipe, `curl \| sh`, a tainted `$(…)` and the exec of a file written from tool output, and annotates an untainted `python -c`; `env -S` no longer launders a delete) | judging a freshly written file on its content, not only its taint: open |
| T6 | Judge injection | `T06-judge-injection.test.ts` | live (core + policy engine + daemon audit flag) | — |
| T7 | Precedent farming | `T07-precedent-farming.test.ts` | live (budget 2x; daemon-proposed scope, TTL, end-to-end doubling; daemon: a direct resolve without the single-use hold token is 403 + anomaly, no precedent, token never in the audit log; budget reset only on the 0600 admin socket, 404 on the agent's); 2 todo | OpenShell JIT grants, and keeping the agent's tools off the socket (a self-posted judge request gets its own token): M2 |
| T8 | Social engineering the human | `T08-social-engineering.test.ts` | live (Pi adapter: confirm shows the daemon's raw command and `detail`; the agent cannot answer for the human over the socket while the confirm is open); 1 todo | Claude Code hold-to-ask: M1 |
| T9 | TOCTOU | `T09-toctou.test.ts` | live (core: opaque; Pi adapter: `rewrite` pins resolved paths in place); 1 todo | Claude Code `updatedInput`: M1 |
| T10 | Taint laundering | `T10-taint-laundering.test.ts` | live (core) | — |
| T11 | Task drift by rewrite | `T11-task-drift.test.ts` | live (core; the Pi adapter sends the first prompt only, `adapters/pi/jevdict.test.ts`) | subagent-spawn policy: M0 step 7 |
| T12 | Log tampering | `T12-log-tampering.test.ts` | live (daemon hash chain: edit, delete, cut line); 1 todo | shipped off-box + `doctor` verify: M2 |
| T13 | Jev exfil path | `T13-jev-exfil-path.test.ts` | todo | M2 (OpenShell policy compilation) |

"Live (core)" means the assertions run against `@jevdict/core` today; "live (daemon)" means
they run against a real `jevdictd` on a temp Unix socket; "live (Pi adapter)" means the Pi
extension (`adapters/pi`), driven by the fake Pi runner in `adapters/pi/testing/fake-pi.ts`,
talks to such a daemon. The same threat is re-asserted
end to end on Pi and Claude Code by M2.
