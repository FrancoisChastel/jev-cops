# @jev-cops/policies

The starter policy set of [jev-cops](https://github.com/FrancoisChastel/jev-cops#readme),
each policy next to the `*.fixtures.json` that pins its verdicts:

| Policy | Catches | Verdicts |
|---|---|---|
| `config-tamper` | writes to harness hook settings, extensions, the policies or the judge's own records; reading the judge's records | annotate → kill |
| `default-branch-guard` | force-push, hard reset and other irreversible git on the default branch | hold, deny when headless |
| `exfil-after-secrets` | network calls to a host the task doesn't need, shortly after a secret read | annotate → kill |
| `tainted-destructive` | deletes and irreversible commands whose target came from tool output | hold → deny |
| `off-repo-write` | writes and deletes outside the repo and `/tmp` | hold |
| `opaque-exec` | `curl \| sh`, base64 pipes, `eval`, inline interpreters, freshly written executables | annotate → hold |

`copsd` loads this directory when `[policies] dir` is not set in `cops.toml`, and protects
it like its other inputs (`config-tamper` kills an agent's write to it). It comes with the
`jev-cops` package:

```bash
bun add -g jev-cops
copsd        # judges with these policies; its boot line names the directory it loaded
```

To run your own set, copy that directory, edit it, check it with `cops test <dir>`, and
point `[policies] dir` at it. `_lib/` holds helpers shared by the policies; any
`_`-prefixed entry is a helper, never a policy. Author guide:
[`@jev-cops/sdk`](https://github.com/FrancoisChastel/jev-cops/blob/master/packages/sdk/README.md).

Runs on [Bun](https://bun.sh) ≥ 1.3 only. Licensed under Apache-2.0.
