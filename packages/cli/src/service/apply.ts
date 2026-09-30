/**
 * Carrying out a {@link ServicePlan}: the steps before the file change, the atomic write (or
 * the removal) under `--home` only, the steps after, then (install) the wait for copsd's
 * `/v1/health`. Steps run only when {@link runBlocker} allows; a failing step stops the rest
 * and leaves the file as the last completed step left it. Never throws.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HEALTH_TIMEOUT_MS, type HealthResult, type ServiceContext } from "./context.ts";
import type { ServicePlan } from "./plan.ts";
import { oneLineOf } from "./text.ts";
import type { Step } from "./units.ts";

/** One step as it ran. */
export interface StepResult {
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly ok: boolean;
  /** stderr, else stdout, as one bounded line. */
  readonly output: string;
}

/** What happened to the unit file. */
export type FileOutcome = "written" | "unchanged" | "removed" | "absent" | null;

/** The outcome of one `install` or `uninstall`. */
export interface ApplyReport {
  readonly file: FileOutcome;
  readonly steps: readonly StepResult[];
  /** Why the steps were not run (dry run, other platform, other home), or null. */
  readonly notRun: string | null;
  readonly health: HealthResult | null;
  readonly error: string | null;
}

async function runSteps(
  steps: readonly Step[],
  ctx: ServiceContext,
): Promise<{ results: StepResult[]; failed: StepResult | null }> {
  const results: StepResult[] = [];
  for (const step of steps) {
    const r = await ctx.run(step.argv);
    const ok = r.code !== null && step.ok.includes(r.code);
    const output = oneLineOf(r.stderr.trim() === "" ? r.stdout : r.stderr);
    const result = { argv: step.argv, code: r.code, ok, output };
    results.push(result);
    if (!ok) return { results, failed: result };
  }
  return { results, failed: null };
}

function stepError(s: StepResult): string {
  const how = s.code === null ? "did not run to an exit" : `exited ${s.code}`;
  return `${s.argv.join(" ")} ${how}${s.output === "" ? "" : `: ${s.output}`}`;
}

/** Writes the unit atomically (0644), creating its directory and `~/.jev-cops/` (0700). */
function writeUnit(plan: ServicePlan, content: string): FileOutcome {
  mkdirSync(dirname(plan.logPath), { recursive: true, mode: 0o700 });
  if (plan.previous === content) return "unchanged";
  const dir = dirname(plan.unitPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.${basename(plan.unitPath)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode: 0o644, flag: "wx" });
  try {
    renameSync(tmp, plan.unitPath);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
  return "written";
}

function changeFile(plan: ServicePlan): FileOutcome {
  if (plan.action === "install") return writeUnit(plan, plan.content ?? "");
  if (plan.previous === null) return "absent";
  rmSync(plan.unitPath, { force: true });
  return "removed";
}

/** Carries out `plan`; `blocker` (from `runBlocker`) keeps every step from running. */
export async function applyPlan(
  plan: ServicePlan,
  ctx: ServiceContext,
  blocker: string | null,
): Promise<ApplyReport> {
  const done = (r: Partial<ApplyReport>): ApplyReport => ({
    file: null,
    steps: [],
    notRun: blocker,
    health: null,
    error: null,
    ...r,
  });
  if (blocker === "dry run") return done({});
  const run = blocker === null;
  const before = run ? await runSteps(plan.before, ctx) : { results: [], failed: null };
  if (before.failed !== null)
    return done({ steps: before.results, error: stepError(before.failed) });
  let file: FileOutcome;
  try {
    file = changeFile(plan);
  } catch (cause) {
    return done({
      steps: before.results,
      error: `cannot ${plan.action === "install" ? "write" : "remove"} ${plan.unitPath}: ${(cause as Error).message}`,
    });
  }
  const after = run ? await runSteps(plan.after, ctx) : { results: [], failed: null };
  const steps = [...before.results, ...after.results];
  if (after.failed !== null) return done({ file, steps, error: stepError(after.failed) });
  if (!run || plan.action !== "install") return done({ file, steps });
  const health = await ctx.health(ctx.home, HEALTH_TIMEOUT_MS);
  const error = health.ok ? null : `copsd did not answer after install: ${health.detail}`;
  return done({ file, steps, health, error });
}
