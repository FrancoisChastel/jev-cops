/**
 * `cops openshell compile|apply|create` (PLAN-M2 §3 steps 1–2, §4; D-106–D-109, D-119):
 * compile the OpenShell policy from the policy set, the repo and the task; diff it locally
 * (jev-cops's own `--dry-run`: `openshell policy set` has none); apply the task-host rules
 * to a running sandbox; create a sandbox with the compiled policy and a pinned advisor
 * posture. Nothing reaches a gateway with `--dry-run`, or when no `openshell` is found.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  diffPolicies,
  type OpenShellPolicy,
  parsePolicyYaml,
  renderDiff,
} from "@jev-cops/openshell";
import { EXIT, type Io } from "../io.ts";
import { runOpenShellApply } from "./openshell-apply.ts";
import {
  COMPILE_FLAGS_USAGE,
  COMPILE_OPTIONS,
  compileFor,
  EXIT_CHANGES,
  parse,
} from "./openshell-args.ts";
import { runOpenShellCreate } from "./openshell-create.ts";

export const OPENSHELL_USAGE = `  openshell compile [--dry-run [--against file]] [--out file]
${COMPILE_FLAGS_USAGE}
                                           compile the OpenShell policy (protection set, judge
                                           route, task allowlist) with its report; --dry-run
                                           diffs it against --against or --out and writes
                                           nothing (exit 3 on changes); exit 1 when refused
  openshell apply <sandbox> [--dry-run] [--openshell path] [compile options]
                                           add the task hosts with openshell policy update
                                           --wait, then check the revision is Loaded;
                                           --dry-run diffs against policy get --base
  openshell create <name> [--from image] [--provider name]… [--env K=V]…
          [--policy-out file] [--dry-run] [--openshell path] [compile options] [-- cmd…]
                                           print, then (with openshell on PATH and no
                                           --dry-run) run sandbox create with the compiled
                                           policy and pin the advisor to manual`;

const COMPILE_ONLY = {
  ...COMPILE_OPTIONS,
  out: { type: "string" },
  against: { type: "string" },
} as const;

function readPrevious(path: string | null, io: Io): OpenShellPolicy | null | "bad" {
  if (path === null || !existsSync(path)) return null;
  const parsed = parsePolicyYaml(readFileSync(path, "utf8"));
  if (parsed.ok) return parsed.value;
  io.err(`cops openshell compile: ${path} is not a valid policy: ${parsed.error.join("; ")}`);
  return "bad";
}

async function runCompile(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parse(argv, COMPILE_ONLY);
  if (!parsed.ok || parsed.positionals.length > 0) {
    io.err(`cops openshell compile: ${parsed.ok ? "unexpected argument" : parsed.error}`);
    return EXIT.usage;
  }
  const v = parsed.values;
  const compiled = await compileFor(v, io, "compile");
  if (typeof compiled === "number") return compiled;
  if (compiled.policy === null || compiled.yaml === null) return EXIT.failed;
  const out = typeof v.out === "string" ? v.out : null;
  if (v["dry-run"] === true) {
    const against = typeof v.against === "string" ? v.against : out;
    const previous = readPrevious(against, io);
    if (previous === "bad") return EXIT.failed;
    const diff = diffPolicies(previous, compiled.policy);
    io.out(`diff against ${against ?? "an empty policy"}:`);
    for (const line of renderDiff(diff)) io.out(`  ${line}`);
    return diff.changed ? EXIT_CHANGES : EXIT.ok;
  }
  if (out === null) io.out(compiled.yaml.trimEnd());
  else writeFileSync(out, compiled.yaml, { mode: 0o644 });
  return EXIT.ok;
}

/** `cops openshell <compile|apply|create> …`; exit 0, 1 (refused or failed), 2 (usage), 3 (changes). */
export async function runOpenShellCommand(argv: readonly string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "compile") return runCompile(rest, io);
  if (sub === "apply") return runOpenShellApply(rest, io);
  if (sub === "create") return runOpenShellCreate(rest, io);
  io.err(`cops openshell: expected compile, apply or create\n\n${OPENSHELL_USAGE}`);
  return EXIT.usage;
}
