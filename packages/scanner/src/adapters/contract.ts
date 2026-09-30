/**
 * The contract every scanner adapter meets (11 checks), run over `none`, `skillspector` and
 * `command` against the fake tool, like `@jev-cops/judge`'s provider contract. The fail-closed
 * rows of PLAN-SETUP §8 are what it checks: every failure is `verdict: "error"`, a URL is
 * never fetched, `none` is never `safe`, and nothing a scan started outlives it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TITLE_CHARS, UNREADABLE_OUTPUT } from "../parse.ts";
import {
  FINDING_SEVERITIES,
  MAX_FINDINGS,
  SCAN_NETWORKS,
  type Scanner,
  type ScanResult,
} from "../types.ts";
import { NO_SCANNER } from "./none.ts";
import { REMOTE_NOT_FETCHED } from "./shared.ts";

/** What the fake tool is asked to do (its `fake-scenario` file). */
export type Scenario =
  | "safe"
  | "caution"
  | "unsafe"
  | "tool-error"
  | "garbage"
  | "huge"
  | "hang"
  | "many";

/** One adapter wired to the fake tool. */
export interface ScannerHarness {
  readonly label: string;
  /** False for `none`: every scan must be an error and nothing may run. */
  readonly runsTool: boolean;
  scanner(): Scanner;
  /** The same adapter with its tool absent; null for `none`, which needs none. */
  missing(): Scanner | null;
  /** A local directory whose scan answers `scenario`. */
  target(scenario: Scenario): string;
  /** How many processes the fake tool has run so far. */
  runs(): number;
}

/** Deadline for scans expected to finish; the hang check uses {@link HANG_DEADLINE_MS}. */
export const CONTRACT_DEADLINE_MS = 10_000;
/** Deadline of the hang check. */
export const HANG_DEADLINE_MS = 800;

/** The invariants of every result, whatever happened. */
export function expectWellFormed(r: ScanResult): void {
  expect(["safe", "caution", "unsafe", "error"]).toContain(r.verdict);
  expect(r.error === null).toBe(r.verdict !== "error");
  if (r.error !== null) {
    expect(r.error.length).toBeGreaterThan(0);
    expect(r.error.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(r.error).not.toMatch(/[\n\r]/);
    expect(r.score).toBeNull();
  }
  if (r.score !== null) expect(r.score >= 0 && r.score <= 100).toBe(true);
  expect(r.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
  expect(r.truncated).toBeGreaterThanOrEqual(0);
  for (const f of r.findings) {
    expect(FINDING_SEVERITIES).toContain(f.severity);
    expect(f.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(f.title).not.toMatch(/[\n\r]/);
  }
  expect(SCAN_NETWORKS).toContain(r.network);
  expect(["static", "llm"]).toContain(r.mode);
  expect(r.tool.length).toBeGreaterThan(0);
  expect(r.durationMs).toBeGreaterThanOrEqual(0);
}

async function scanDir(h: ScannerHarness, scenario: Scenario, deadlineMs = CONTRACT_DEADLINE_MS) {
  const r = await h.scanner().scan({ kind: "dir", path: h.target(scenario) }, { deadlineMs });
  expectWellFormed(r);
  return r;
}

/** For `none`: every scenario is the same error and runs nothing. */
async function expectNoScanner(h: ScannerHarness, scenario: Scenario): Promise<void> {
  const before = h.runs();
  const r = await scanDir(h, scenario);
  expect(r).toMatchObject({ verdict: "error", error: NO_SCANNER, network: "none" });
  expect(h.runs()).toBe(before);
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function expectHangKilled(h: ScannerHarness): Promise<void> {
  const dir = h.target("hang");
  const started = performance.now();
  const r = await h.scanner().scan({ kind: "dir", path: dir }, { deadlineMs: HANG_DEADLINE_MS });
  expectWellFormed(r);
  expect(r).toMatchObject({ verdict: "error", error: "timeout" });
  expect(performance.now() - started).toBeLessThan(HANG_DEADLINE_MS + 1_500);
  const pidFile = join(dir, "hang.pid");
  if (!existsSync(pidFile)) return; // killed before it could start its child
  const child = Number(readFileSync(pidFile, "utf8"));
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = pidGone(child);
    if (!gone) await Bun.sleep(20);
  }
  expect(gone).toBe(true);
}

function verdictChecks(h: ScannerHarness): void {
  test("1. a safe skill reads safe (none: an error, never safe)", async () => {
    if (!h.runsTool) return expectNoScanner(h, "safe");
    const r = await scanDir(h, "safe");
    expect(r).toMatchObject({ verdict: "safe", error: null, findings: [], truncated: 0 });
  });

  test("2. a caution skill reads caution, with its findings", async () => {
    if (!h.runsTool) return expectNoScanner(h, "caution");
    const r = await scanDir(h, "caution");
    expect(r.verdict).toBe("caution");
    expect(r.findings.map((f) => f.id)).toEqual(["E1", "SC1"]);
  });

  test("3. an unsafe skill reads unsafe, most severe first; prompt-like titles flagged", async () => {
    if (!h.runsTool) return expectNoScanner(h, "unsafe");
    const r = await scanDir(h, "unsafe");
    expect(r.verdict).toBe("unsafe");
    expect(r.findings[0]?.severity).toBe("critical");
    expect(r.promptLike).toEqual(["ignore-instructions", "answer-directive"]);
  });

  test("8. 70 findings: 64 kept, most severe first, 6 counted", async () => {
    if (!h.runsTool) return expectNoScanner(h, "many");
    const r = await scanDir(h, "many");
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.truncated).toBe(6);
    expect(r.findings[0]?.severity).toBe("critical");
    expect(r.findings.at(-1)?.severity).toBe("low");
  });
}

function failureChecks(h: ScannerHarness): void {
  test("4. a tool error is verdict error with one bounded line", async () => {
    if (!h.runsTool) return expectNoScanner(h, "tool-error");
    const r = await scanDir(h, "tool-error");
    expect(r.verdict).toBe("error");
    expect(r.findings).toEqual([]);
  });

  test("5. output that is not the contract's JSON is unreadable", async () => {
    if (!h.runsTool) return expectNoScanner(h, "garbage");
    expect((await scanDir(h, "garbage")).error).toBe(UNREADABLE_OUTPUT);
  });

  test("6. a hang past the deadline is a timeout and its process group is killed", async () => {
    if (!h.runsTool) return expectNoScanner(h, "hang");
    await expectHangKilled(h);
  });

  test("7. output over 4 MiB is an error, never a truncated parse", async () => {
    if (!h.runsTool) return expectNoScanner(h, "huge");
    expect((await scanDir(h, "huge")).error).toBe("scanner output over 4 MiB");
  });
}

function boundaryChecks(h: ScannerHarness): void {
  test("9. a URL is never fetched: an error, no process", async () => {
    const before = h.runs();
    const r = await h
      .scanner()
      .scan(
        { kind: "url", url: "https://example.com/skill.git", fetchedBy: "daemon" },
        { deadlineMs: 1_000 },
      );
    expectWellFormed(r);
    expect(r).toMatchObject({
      verdict: "error",
      error: h.runsTool ? REMOTE_NOT_FETCHED : NO_SCANNER,
    });
    expect(h.runs()).toBe(before);
  });

  test("10. a missing tool: available() is not ok, scan() is an error, never a throw", async () => {
    const missing = h.missing();
    if (missing === null) {
      expect(await h.scanner().available()).toEqual({ ok: true, version: null });
      return;
    }
    const a = await missing.available();
    expect(a.ok).toBe(false);
    const r = await missing.scan({ kind: "dir", path: h.target("safe") }, { deadlineMs: 1_000 });
    expectWellFormed(r);
    expect(r.verdict).toBe("error");
  });

  test("11. a relative or absent target is an error and runs nothing", async () => {
    const before = h.runs();
    for (const path of ["skills/x", join(h.target("safe"), "absent")]) {
      const r = await h.scanner().scan({ kind: "dir", path }, { deadlineMs: 1_000 });
      expectWellFormed(r);
      expect(r.verdict).toBe("error");
    }
    expect(h.runs()).toBe(before);
  });
}

/** Registers the 11 contract checks for one adapter. */
export function describeScannerContract(h: ScannerHarness): void {
  describe(`scanner contract: ${h.label}`, () => {
    verdictChecks(h);
    failureChecks(h);
    boundaryChecks(h);
  });
}
