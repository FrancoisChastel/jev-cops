#!/usr/bin/env bun
/**
 * `cops-hook`, as the `jev-cops` package installs it: the Claude Code command hook of
 * `@jev-cops/adapter-claude-code`, which `cops install claude-code` registers from here.
 *
 * Like the adapter's `hook-main.ts`, the first statement sets exit code 2 and the runtime is
 * imported dynamically, so a module that fails to load (a broken install included) exits 2,
 * a block, instead of Bun's 1, which Claude Code treats as "proceed".
 */
process.exitCode = 2;
try {
  const { runHookProcess } = await import("@jev-cops/adapter-claude-code/process");
  await runHookProcess(process.argv.slice(2), []);
} catch (cause) {
  const why = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`jev-cops: hook failed to start (${why}); blocking (fail closed)\n`);
  process.exit(2);
}

export {};
