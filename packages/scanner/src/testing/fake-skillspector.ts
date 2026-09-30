#!/usr/bin/env bun
/**
 * A stand-in for NVIDIA SkillSpector's CLI, compiled once per test run (`fake-binary.ts`).
 * It speaks the documented contract (exit 0/1/2, `--format json` on stdout) and, with
 * `--contract`, the `command` adapter's `jev-cops.scan/1`. What it answers is chosen by a
 * `fake-scenario` file in the scanned directory (a file's own directory); default `safe`.
 * Each call is appended to `$HOME/fake-skillspector.calls.jsonl` (argv, env, cwd).
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import caution from "./fixtures/caution.json" with { type: "json" };
import doNotInstall from "./fixtures/do-not-install.json" with { type: "json" };
import llmUnavailable from "./fixtures/llm-requested-unavailable.json" with { type: "json" };
import missingRecommendation from "./fixtures/missing-recommendation.json" with { type: "json" };
import safe from "./fixtures/safe.json" with { type: "json" };

const HANG_MS = 60_000;
const HUGE_BYTES = 5 * 1024 * 1024;

/** One issue of the documented report (the fields the fixtures carry). */
interface Issue {
  readonly id: string;
  readonly category?: string;
  readonly severity: string;
  readonly confidence?: number;
  readonly title?: string;
  readonly location: { readonly file: string; readonly start_line: number };
}

/** The documented top-level report, loosely: the fake only rewrites issues and metadata. */
interface Report {
  readonly [key: string]: unknown;
  readonly issues: readonly Issue[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

function record(argv: string[]): void {
  const home = process.env.HOME;
  if (home === undefined || !existsSync(home)) return;
  const line = JSON.stringify({ argv, env: process.env, cwd: process.cwd() });
  appendFileSync(join(home, "fake-skillspector.calls.jsonl"), `${line}\n`);
}

function scenarioOf(target: string | undefined): string {
  if (target === undefined || !existsSync(target)) return "missing-target";
  const dir = statSync(target).isDirectory() ? target : dirname(target);
  const marker = join(dir, "fake-scenario");
  return existsSync(marker) ? readFileSync(marker, "utf8").trim() : "safe";
}

function many(): Report {
  const severities = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const issues = Array.from({ length: 70 }, (_, i) => ({
    id: `R${i}`,
    category: "test",
    severity: severities[i % 4] ?? "LOW",
    confidence: 0.5,
    title: `finding ${i}`,
    location: { file: "SKILL.md", start_line: i + 1 },
  }));
  return { ...doNotInstall, issues };
}

async function hang(): Promise<never> {
  const child = Bun.spawn(["/bin/sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(process.cwd(), "hang.pid"), String(child.pid));
  await Bun.sleep(HANG_MS);
  process.exit(0);
}

function withLlm(report: Report, llm: boolean): Report {
  return { ...report, metadata: { ...report.metadata, llm_requested: llm, llm_available: llm } };
}

/** SkillSpector's `scan <target> --format json [--no-llm]`. */
async function scan(args: string[]): Promise<number> {
  const scenario = scenarioOf(args[0]);
  const llm = !args.includes("--no-llm");
  const reports: Record<string, [Report, number]> = {
    safe: [withLlm(safe, llm), 0],
    caution: [withLlm(caution, llm), 0],
    unsafe: [withLlm(doNotInstall, llm), 1],
    many: [withLlm(many(), llm), 1],
    "llm-ran": [withLlm(safe, true), 0],
    "llm-unavailable": [llmUnavailable, 0],
    "missing-recommendation": [missingRecommendation, 0],
  };
  const known = reports[scenario];
  if (known !== undefined) {
    await Bun.write(Bun.stdout, JSON.stringify(known[0]));
    return known[1];
  }
  return special(scenario);
}

async function special(scenario: string): Promise<number> {
  switch (scenario) {
    case "garbage":
      await Bun.write(Bun.stdout, "Scanning... done. Everything looks fine!\n");
      return 0;
    case "huge":
      await Bun.write(Bun.stdout, "x".repeat(HUGE_BYTES));
      return 0;
    case "hang":
      return hang();
    default:
      await Bun.write(Bun.stderr, `Error: unreadable source (${scenario})\n`);
      return 2;
  }
}

/** The `command` adapter's contract: `fake --contract <target>` prints `jev-cops.scan/1`. */
async function contract(target: string | undefined): Promise<number> {
  const scenario = scenarioOf(target);
  const doc = (verdict: string, report: Report, score: number | null) => ({
    schema: "jev-cops.scan/1",
    verdict,
    score,
    tool: "fake-scanner",
    version: "0.9.0",
    network: "none",
    findings: report.issues.map((i) => ({
      id: i.id,
      severity: String(i.severity).toLowerCase(),
      title: i.title ?? i.id,
      file: i.location.file,
      line: i.location.start_line,
    })),
  });
  const docs: Record<string, unknown> = {
    safe: doc("safe", safe, 0),
    caution: doc("caution", caution, 35),
    unsafe: doc("unsafe", doNotInstall, 78),
    many: doc("unsafe", many(), 99),
    "tool-error": { schema: "jev-cops.scan/1", verdict: "error", error: "database\nlocked" },
    "missing-verdict": { schema: "jev-cops.scan/1", tool: "fake-scanner" },
  };
  const known = docs[scenario];
  if (known === undefined) return special(scenario);
  await Bun.write(Bun.stdout, JSON.stringify(known));
  return scenario === "unsafe" ? 3 : 0; // the exit code is ignored by the adapter
}

async function main(argv: string[]): Promise<number> {
  record(argv);
  const [first, ...rest] = argv;
  if (first === "--version") {
    const pinned = join(process.env.HOME ?? "/nonexistent", "fake-skillspector-version");
    const version = existsSync(pinned) ? readFileSync(pinned, "utf8").trim() : "2.12.0";
    if (version === "fail") {
      await Bun.write(Bun.stderr, "Traceback: ImportError\n");
      return 1;
    }
    await Bun.write(Bun.stdout, `skillspector, version ${version}\n`);
    return 0;
  }
  if (first === "--contract") return contract(rest[0]);
  if (first === "scan") return scan(rest);
  await Bun.write(Bun.stderr, `Usage: skillspector scan <target> (got ${first ?? "nothing"})\n`);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
