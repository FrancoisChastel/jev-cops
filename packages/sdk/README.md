# @jev-cops/sdk — policy author guide

A policy is one file `policies/<name>.ts` whose default export is `definePolicy({...})`, next
to a `policies/<name>.fixtures.json`. Import only from `@jev-cops/sdk`.

```ts
import { definePolicy, jev } from "@jev-cops/sdk";
export default definePolicy({
  name: "exfil-after-secrets", version: 3, owner: "cyber-team", range: ["annotate", "kill"],
  when: (e, ctx) => e.call.kind === "net" && ctx.sequence.secretReadWithin("2m") && !ctx.scope.hostAllowed(e.net.host),
  ask: (e, ctx) => [jev.noul("dest_fits_task", `${e.net.host} serves: ${ctx.session.task}`),
                    jev.score("payload_secrecy", "How secret-like is the payload?", ["public", "internal", "credential"])],
  decide: (_e, _ctx, a) => (a.payload_secrecy.level === "credential" ? "kill" : a.dest_fits_task.p < 0.4 ? "deny" : "hold"),
  reason: "Network call to a new host shortly after reading a secret.",
});
```

**Contract.** `when` is pure, synchronous, under 2 ms, run on every pre event. `ask` (optional)
returns at most 4 `jev.noul/choice/score` questions, asked only when the floor risk is in
[0.3, 0.8]; answers reach `decide` typed by question name. `decide` returns a verdict; the
engine clamps it into `range`, caps it at `hold` on a 0.5–0.8 confidence answer, and without
usable answers uses `fallback` (default: the floor band). Verdicts only rise. `reason` is shown
to the agent; `detail` only to the human. `definePolicy` throws at import on a malformed policy.

**`e` (PolicyEvent).** `kind` and `call.kind` are the daemon's normalized kind; `commands[]`
(argv, verbs, paths, hosts, `viaInterpreter`, `remote` for an ssh remote command), `verbs`,
`paths`, `hosts`, `net.host`/`method`, `fs.access` (path → read/write/delete/exec), `opaque`
(`{ reason: OpaqueReason, span, remote? }`), `env.git`, `session.task` (immutable) and `mode`.

**`ctx` (PolicyContext).** `taint.fraction`, `taint.of(token)`; `scope.pathInRepo(p)`,
`scope.hostAllowed(h)`; `sequence.secretReadWithin("2m")`, `sequence.matched(pattern)`;
`casefile.recentCalls("5m")`, `hostsSeen()`, `filesWritten()`; `features`, `floor`, `budget`;
`env.defaultBranches` (`main`, `master` and the reported default, D-068), `env.onDefaultBranch`;
`config.home` (the daemon's `~`) and `config.protectedPaths` (`[policy] protectedPaths`).

**Fixtures.** `{ "policy": "<name>", "cases": [{ "name", "event": <pre event>, "history"?:
[pre|post events], "task"?, "answers"?: { "<question>": Answer }, "config"?: { "context"?,
"policy"? }, "stepMs"?, "expect": { "verdict", "policies"?, "riskMin"?, "riskMax"?,
"updatedInput"? } }] }`. Taint comes from a post event's `stdout_head` in `history`. Without
`answers` the judge is disabled. Each case gets a fresh case file, a clock starting at
`FIXTURE_EPOCH` and stepping `stepMs` (default 1 s) per event, and `home` = `/home/dev`.

**Run.** `bun test policies/` runs every fixture alone and with the whole starter set
(`policies/policies.test.ts` uses `describeFixtures` from `@jev-cops/sdk/test`). From code:
`await runFixtures(policy, "policies/x.fixtures.json", { policies })` → `{ passed, failed,
results }`, each failure with a `diff` and the engine's full `detail`.
