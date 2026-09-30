#!/usr/bin/env bun
/**
 * `cops-hook`: the Claude Code command hook (compiled by `bun run build:hook` into
 * `dist/cops-hook`, D-079 proposal). Registered in exec form:
 * `{ "type": "command", "command": "/path/to/cops-hook", "args": ["--harness", "claude-code", "--socket", "…"] }`.
 *
 * The first statement sets exit code 2 and the runtime is imported dynamically, so even a
 * module that fails to load exits 2 (a block) instead of Bun's 1 (which Claude Code treats
 * as "proceed"). No static imports: nothing can run before the exit code is set.
 */
process.exitCode = 2;
try {
  const { runHookProcess } = await import("./process.ts");
  await runHookProcess(process.argv.slice(2), []);
} catch (cause) {
  const why = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`jev-cops: hook failed to start (${why}); blocking (fail closed)\n`);
  process.exit(2);
}

export {};
