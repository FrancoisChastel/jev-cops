/**
 * `cops openshell apply <sandbox> [--dry-run]`: the live part of the compiled policy (D-109:
 * the hosts the task names, one `openshell policy update … --wait --timeout 20` each) on a
 * running sandbox, in order, stopping at the first that does not apply, then confirming
 * the latest revision is `Loaded` (a successful `--wait` "does not always mean your change
 * is active", manage-policies.mdx:260-270). Filesystem sections are creation-only
 * (manage-policies.mdx:189-195): they are diffed, never applied here.
 */

import type { CompiledPolicy } from "@jev-cops/openshell";
import {
  commandLine,
  diffPolicies,
  type OpenShellCli,
  openShellCli,
  policyUpdateArgs,
  renderDiff,
} from "@jev-cops/openshell";
import { EXIT, type Io } from "../io.ts";
import {
  COMPILE_OPTIONS,
  compileFor,
  EXIT_CHANGES,
  openShellBinary,
  parse,
} from "./openshell-args.ts";

function cliFor(binary: string, io: Io): OpenShellCli | null {
  const made = openShellCli({ binary, home: process.env.HOME ?? "/nonexistent" });
  if (made.ok) return made.value;
  io.err(`cops openshell apply: ${made.error}`);
  return null;
}

async function dryRun(
  sandbox: string,
  compiled: CompiledPolicy,
  cli: OpenShellCli | null,
  io: Io,
): Promise<number> {
  for (const u of compiled.updates) {
    io.out(`would run: ${commandLine("openshell", policyUpdateArgs(sandbox, u))}`);
  }
  if (compiled.updates.length === 0) io.out("would run: nothing (no task hosts)");
  if (cli === null || compiled.policy === null) {
    io.out("openshell not found: no diff against the sandbox's base policy");
    return compiled.updates.length > 0 ? EXIT_CHANGES : EXIT.ok;
  }
  const base = await cli.policyGetBase(sandbox);
  if (!base.ok) {
    io.err(`cops openshell apply: ${base.error}`);
    return EXIT.failed;
  }
  const diff = diffPolicies(base.value.policy, compiled.policy);
  io.out(`diff against ${sandbox}'s base policy (revision ${base.value.version}):`);
  for (const line of renderDiff(diff)) io.out(`  ${line}`);
  return diff.changed ? EXIT_CHANGES : EXIT.ok;
}

async function apply(sandbox: string, compiled: CompiledPolicy, cli: OpenShellCli, io: Io) {
  for (const u of compiled.updates) {
    const r = await cli.policyUpdate(sandbox, u);
    io.out(`${r.status}: ${commandLine("openshell", policyUpdateArgs(sandbox, u))}`);
    if (r.status !== "applied") {
      io.err(
        `cops openshell apply: ${r.status} (exit ${r.code})${r.stderr ? `: ${r.stderr}` : ""}`,
      );
      return EXIT.failed;
    }
  }
  if (compiled.updates.length === 0) {
    io.out("nothing to apply: the task names no host");
    return EXIT.ok;
  }
  const loaded = await cli.latestLoaded(sandbox);
  if (loaded.ok && loaded.value) return EXIT.ok;
  io.err(
    `cops openshell apply: the latest revision is not Loaded${loaded.ok ? "" : `: ${loaded.error}`}`,
  );
  return EXIT.failed;
}

/** `cops openshell apply <sandbox> …`; exit 0, 1, 2, or 3 (dry run with changes). */
export async function runOpenShellApply(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parse(argv, COMPILE_OPTIONS);
  if (!parsed.ok || parsed.positionals.length !== 1) {
    io.err(
      `cops openshell apply: ${parsed.ok ? "expected exactly one sandbox name" : parsed.error}`,
    );
    return EXIT.usage;
  }
  const sandbox = parsed.positionals[0] ?? "";
  const compiled = await compileFor(parsed.values, io, "apply");
  if (typeof compiled === "number") return compiled;
  if (compiled.policy === null) return EXIT.failed;
  const binary = openShellBinary(parsed.values);
  const cli = binary === null ? null : cliFor(binary, io);
  if (parsed.values["dry-run"] === true) return dryRun(sandbox, compiled, cli, io);
  if (cli === null) {
    io.err(
      "cops openshell apply: openshell not found on PATH (pass --openshell path): nothing applied",
    );
    return EXIT.failed;
  }
  return apply(sandbox, compiled, cli, io);
}
