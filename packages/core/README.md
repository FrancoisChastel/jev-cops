# @jev-cops/core

The engine of [jev-cops](https://github.com/FrancoisChastel/jev-cops#readme): the canonical
`jev-cops.event/1` and `jev-cops.verdict/1` schemas, the bash normalizer (tree-sitter-bash,
loaded as WASM), the context engine (taint, scope, sequence, case file) and the policy
engine that turns policies and judge answers into a verdict.

Most people never import it directly. Install the `jev-cops` package for the commands, or
`@jev-cops/sdk` to write policies:

```bash
bun add -g jev-cops         # cops, copsd, cops-hook and the starter policies
bun add -d @jev-cops/sdk    # policy authors
```

Runs on [Bun](https://bun.sh) ≥ 1.3 only; the package ships TypeScript sources.

Documentation: the [project README](https://github.com/FrancoisChastel/jev-cops#readme) and
the [spec](https://github.com/FrancoisChastel/jev-cops/blob/master/docs/SPEC.md).
Licensed under Apache-2.0.
