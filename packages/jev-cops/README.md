# jev-cops

**Context-aware policing for coding agents.** Every tool call your agent makes is judged in
context and gets a graduated verdict (`allow` · `annotate` · `rewrite` · `hold` · `deny` ·
`kill`) before it runs.

This package installs the commands and the starter policies. It needs
[Bun](https://bun.sh) ≥ 1.3 on macOS or Linux (Node is not a supported runtime):

```bash
bun add -g jev-cops                   # or: npm install -g jev-cops, with bun on PATH
copsd &                               # the judge, in observe mode (logs, blocks nothing)
cops install claude-code --dry-run    # show the settings change, write nothing
cops install claude-code              # register cops-hook (also: cops install pi)
cops doctor                           # check the daemon, the hook, and run a canary call
```

| Command | What it is |
|---|---|
| `cops` | the command line: `test`, `explain`, `replay`, `budget`, `install`, `doctor` |
| `copsd` | the judging daemon; with no `[policies] dir` it loads the starter set |
| `cops-hook` | the Claude Code command hook that `cops install claude-code` registers |

Everything else (how it works, policies, the semantic judge, configuration, the security
model and its known gaps) is in the
[project README](https://github.com/FrancoisChastel/jev-cops#readme).
Licensed under Apache-2.0.
