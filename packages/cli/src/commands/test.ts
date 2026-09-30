import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isPolicyHelper, loadPolicies, type PolicyDefinition } from "@jev-cops/core";
import { type CaseResult, type FixtureFile, loadFixtures, runFixtures } from "@jev-cops/sdk";
import { EXIT, type Io } from "../io.ts";
import { renderTable } from "../table.ts";

/** One fixture file's outcome, judged alone and with the whole set. */
export interface FixtureRow {
  readonly policy: string;
  readonly file: string;
  readonly cases: number;
  readonly alone: { readonly passed: number; readonly failed: number };
  readonly withSet: { readonly passed: number; readonly failed: number };
  readonly failures: ReadonlyArray<{ mode: "alone" | "with set"; name: string; diff: string }>;
}

/** What `cops test` found; `ok` only when no row failed and nothing was a problem. */
export interface TestReport {
  readonly dir: string;
  readonly policies: number;
  readonly rows: readonly FixtureRow[];
  readonly problems: readonly string[];
  readonly ok: boolean;
}

const FIXTURE_FILE = /\.fixtures\.json$/;

function failuresOf(mode: "alone" | "with set", results: readonly CaseResult[]) {
  return results.filter((r) => !r.ok).map((r) => ({ mode, name: r.name, diff: r.diff ?? "" }));
}

async function runFile(
  file: string,
  fixtures: FixtureFile,
  policy: PolicyDefinition,
  all: readonly PolicyDefinition[],
): Promise<FixtureRow> {
  const alone = await runFixtures(policy, fixtures);
  const withSet = await runFixtures(policy, fixtures, { policies: all });
  return {
    policy: policy.name,
    file,
    cases: fixtures.cases.length,
    alone: { passed: alone.passed, failed: alone.failed },
    withSet: { passed: withSet.passed, failed: withSet.failed },
    failures: [...failuresOf("alone", alone.results), ...failuresOf("with set", withSet.results)],
  };
}

async function fixtureFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => FIXTURE_FILE.test(f) && !isPolicyHelper(f)).sort();
  } catch {
    return [];
  }
}

/**
 * The M0 gate (spec: "`cops test` fails the build on any mismatch"): loads `dir` the
 * way the daemon does, runs every `*.fixtures.json` through the SDK runner against its
 * policy alone and against the whole set (`_`-prefixed helpers and their fixture files are
 * not part of it). Loader problems, fixtures for unknown policies and policies without
 * fixtures are failures too.
 */
export async function testPolicies(dir: string): Promise<TestReport> {
  const loaded = await loadPolicies(dir);
  const problems = [...loaded.problems];
  const byName = new Map(loaded.policies.map((p) => [p.name, p]));
  const covered = new Set<string>();
  const rows: FixtureRow[] = [];
  for (const file of await fixtureFiles(dir)) {
    const fixtures = await loadFixtures(join(dir, file));
    if (!fixtures.ok) {
      problems.push(`${file}: ${fixtures.error.join("; ")}`);
      continue;
    }
    const policy = byName.get(fixtures.value.policy);
    if (policy === undefined) {
      problems.push(`${file}: fixtures for unknown policy "${fixtures.value.policy}"`);
      continue;
    }
    covered.add(policy.name);
    rows.push(await runFile(file, fixtures.value, policy, loaded.policies));
  }
  for (const p of loaded.policies) {
    if (!covered.has(p.name)) problems.push(`policy ${p.name} has no fixtures`);
  }
  const failed = rows.some((r) => r.alone.failed + r.withSet.failed > 0);
  const ok = !failed && problems.length === 0;
  return { dir, policies: loaded.policies.length, rows, problems, ok };
}

function ratio(r: { passed: number; failed: number }): string {
  return `${r.passed}/${r.passed + r.failed}`;
}

/** The human rendering of a report: table, failures with diffs, problems, summary. */
export function renderReport(report: TestReport): string[] {
  const table = renderTable(
    ["policy", "fixtures", "cases", "alone", "with set"],
    report.rows.map((r) => [r.policy, r.file, String(r.cases), ratio(r.alone), ratio(r.withSet)]),
    ["left", "left", "right", "right", "right"],
  );
  const failures = report.rows.flatMap((r) =>
    r.failures.flatMap((f) => [
      `FAIL ${r.policy} (${f.mode}) · ${f.name}`,
      ...f.diff.split("\n").map((l) => `  ${l}`),
    ]),
  );
  const problems = report.problems.map((p) => `PROBLEM ${p}`);
  const cases = report.rows.reduce((n, r) => n + r.cases, 0);
  const failed = report.rows.reduce((n, r) => n + r.alone.failed + r.withSet.failed, 0);
  const summary = [
    `${report.policies} policies`,
    `${cases} cases`,
    `${cases * 2} runs`,
    `${failed} failed`,
    `${report.problems.length} problems`,
  ].join(" · ");
  return [...table, "", ...failures, ...problems, `${summary} → ${report.ok ? "PASS" : "FAIL"}`];
}

/** `cops test [dir] [--json]`: exit 0 green, 1 on any mismatch or problem, 2 usage. */
export async function runTestCommand(argv: readonly string[], io: Io): Promise<number> {
  let parsed: { values: { json?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { json: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (cause) {
    io.err(`cops test: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  if (parsed.positionals.length > 1) {
    io.err("cops test: expected at most one directory");
    return EXIT.usage;
  }
  const report = await testPolicies(resolve(parsed.positionals[0] ?? "policies"));
  if (parsed.values.json === true) io.out(JSON.stringify(report, null, 2));
  else for (const line of renderReport(report)) io.out(line);
  return report.ok ? EXIT.ok : EXIT.failed;
}
