/**
 * `cops doctor` output: a grouped table with ✓ ! ✗ • markers on a terminal (bracketed words
 * otherwise, for logs and CI), or one JSON document with `--json`. Exit code: 1 when any
 * check failed, else 0 (warnings and gaps do not fail).
 */
import { CLI_VERSION } from "../version.ts";
import type { Check, CheckStatus, HarnessChoice } from "./doctor-types.ts";

/** How many checks came out in each status. */
export type Counts = Readonly<Record<CheckStatus, number>>;

const TTY_MARKS: Readonly<Record<CheckStatus, string>> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  gap: "•",
};
const ASCII_MARKS: Readonly<Record<CheckStatus, string>> = {
  ok: "[ok]  ",
  warn: "[warn]",
  fail: "[FAIL]",
  gap: "[gap] ",
};
const MAX_NAME = 28;

/** Checks per status. */
export function countChecks(checks: readonly Check[]): Counts {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, gap: 0 };
  for (const c of checks) counts[c.status] += 1;
  return counts;
}

/** 1 when any check failed, else 0. */
export function exitCodeOf(checks: readonly Check[]): 0 | 1 {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

function groups(checks: readonly Check[]): Map<string, Check[]> {
  const out = new Map<string, Check[]>();
  for (const c of checks) out.set(c.group, [...(out.get(c.group) ?? []), c]);
  return out;
}

/** The report for a person: one block per group, then the totals and the exit code. */
export function renderHuman(checks: readonly Check[], tty: boolean): string[] {
  const marks = tty ? TTY_MARKS : ASCII_MARKS;
  const width = Math.min(
    MAX_NAME,
    Math.max(0, ...checks.filter((c) => c.status !== "gap").map((c) => c.name.length)),
  );
  const lines = [`cops doctor (jev-cops ${CLI_VERSION})`];
  for (const [group, list] of groups(checks)) {
    lines.push("", group);
    for (const c of list) {
      const label = c.status === "gap" ? "" : `${c.name.padEnd(width)}  `;
      lines.push(`  ${marks[c.status]} ${label}${c.detail}`);
    }
  }
  const n = countChecks(checks);
  lines.push(
    "",
    `${n.ok} ok · ${n.warn} warn · ${n.fail} fail · ${n.gap} gap → exit ${exitCodeOf(checks)}`,
  );
  return lines;
}

/** The report for machines (`--json`). */
export function renderJson(checks: readonly Check[], harness: HarnessChoice): string {
  const report = {
    schema: "jev-cops.doctor/1",
    cops_version: CLI_VERSION,
    harness,
    exit_code: exitCodeOf(checks),
    counts: countChecks(checks),
    checks: checks.map(({ group, name, status, detail }) => ({ group, name, status, detail })),
  };
  return JSON.stringify(report, null, 2);
}
