# Tamper tests

One file per threat in the spec's threat model (`docs/SPEC.md` §Threat model and
anti-tamper acceptance tests). Each file quotes the spec's attack and required outcome at
the top. A threat whose outcome cannot be asserted yet stays as `test.todo` named with the
required outcome, until its milestone. Do not delete or weaken one (CONTRIBUTING.md).

| # | Threat | File | Status | Milestone |
|---|---|---|---|---|
| T1 | Config tampering | `T01-config-tamper.test.ts` | todo | M1 (config-tamper policy, `ConfigChange`); M2 (OpenShell) |
| T2 | Daemon killed or unreachable | `T02-daemon-unreachable.test.ts` | live (daemon: 500 + anomaly, refused socket); 1 todo | adapter fail-closed: M0 step 10 |
| T3 | Hook timeout | `T03-hook-timeout.test.ts` | live (daemon: 504 "judge timeout" at the deadline); 1 todo | adapter maps 504 to deny: M0 step 10 |
| T4 | Harness gap | `T04-harness-gap.test.ts` | todo | M2 (OpenShell compiler); M1/M3 installers |
| T5 | Obfuscation | `T05-obfuscation.test.ts` | live (core) | policy judging on file content: M0 step 5 |
| T6 | Judge injection | `T06-judge-injection.test.ts` | live (core + policy engine + daemon audit flag) | — |
| T7 | Precedent farming | `T07-precedent-farming.test.ts` | live (budget 2x; daemon-proposed scope, TTL, end-to-end doubling); 1 todo | OpenShell JIT grants: M2 |
| T8 | Social engineering the human | `T08-social-engineering.test.ts` | todo | M1 (hold-to-ask confirm prompt) |
| T9 | TOCTOU | `T09-toctou.test.ts` | live (opaque); 1 todo | rewrite pinning: M0 steps 5 and 10 |
| T10 | Taint laundering | `T10-taint-laundering.test.ts` | live (core) | — |
| T11 | Task drift by rewrite | `T11-task-drift.test.ts` | live (core) | subagent-spawn policy: M0 step 7 |
| T12 | Log tampering | `T12-log-tampering.test.ts` | live (daemon hash chain: edit, delete, cut line); 1 todo | shipped off-box + `doctor` verify: M2 |
| T13 | Jev exfil path | `T13-jev-exfil-path.test.ts` | todo | M2 (OpenShell policy compilation) |

"Live (core)" means the assertions run against `@jevdict/core` today; "live (daemon)" means
they run against a real `jevdictd` on a temp Unix socket. The same threat is re-asserted
end to end on Pi and Claude Code by M2.
