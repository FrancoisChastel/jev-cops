# @jev-cops/cli

`cops`, the [jev-cops](https://github.com/FrancoisChastel/jev-cops#readme) command line:

| Command | What it does |
|---|---|
| `cops test [dir]` | runs every `*.fixtures.json` against its policy and against the whole set |
| `cops explain <event-id>` | shows a judged event's decision, features, trace and normalized command |
| `cops replay <audit.jsonl>` | re-judges recorded events with the current policies |
| `cops budget <session-id>` | shows (or, on the admin socket, resets) a session's risk budget |
| `cops install claude-code\|pi` | registers the hook or extension, with a backup and a canary |
| `cops doctor` | checks the daemon, the audit chain and each harness install |

Most people install the `jev-cops` package, which brings `cops` together with `copsd`,
`cops-hook` and the starter policies:

```bash
bun add -g jev-cops
cops --help
```

Runs on [Bun](https://bun.sh) ≥ 1.3 only; the package ships TypeScript sources. See the
[project README](https://github.com/FrancoisChastel/jev-cops#readme). Licensed under
Apache-2.0.
