# @jev-cops/daemon

`copsd`, the [jev-cops](https://github.com/FrancoisChastel/jev-cops#readme) judging daemon.
Harness adapters send it every tool call over a Unix socket (or loopback HTTP); it
normalizes the call, runs the policies, asks the optional semantic judge, and answers with
a verdict. It keeps case files and precedents in SQLite and writes every decision to a
hash-chained JSONL audit log. A second, human-only admin socket serves budget resets and
full explanations.

Install it with the rest of the commands:

```bash
bun add -g jev-cops
copsd            # observe mode: logs every verdict, blocks nothing
copsd --enforce  # return verdicts as judged
```

With no `[policies] dir` in `cops.toml`, `copsd` loads the starter set of the installed
`@jev-cops/policies` package (its boot line names the directory) and protects it from the
agent; it refuses to start with no policy at all. Run `copsd --help` for the options.

Runs on [Bun](https://bun.sh) ≥ 1.3 only (it uses `bun:sqlite`). Configuration, security
model and commands: see the [project README](https://github.com/FrancoisChastel/jev-cops#readme).
Licensed under Apache-2.0.
