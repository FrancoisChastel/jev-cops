/**
 * Reading scanner output (PLAN-SETUP §4.1 `parse.ts`): strict schemas per tool (unknown
 * fields ignored, required ones validated; any miss is {@link UNREADABLE_OUTPUT}), every
 * text a tool wrote flattened to one bounded line, findings kept most severe first.
 */
import { err, findPromptLikeStrings, ok, type Result } from "@jev-cops/core";
import { z } from "zod";
import {
  FINDING_SEVERITIES,
  type FindingSeverity,
  MAX_FINDINGS,
  SCAN_NETWORKS,
  type ScanFinding,
  type ScanNetwork,
  type ScanVerdict,
} from "./types.ts";

/** The error of any output that is not the tool's documented JSON. */
export const UNREADABLE_OUTPUT = "unreadable scanner output";
/** Longest finding title or error line. */
export const MAX_TITLE_CHARS = 200;
/** Longest finding id. */
export const MAX_ID_CHARS = 64;
/** Longest finding file path. */
export const MAX_FILE_CHARS = 512;

// Every control character and whitespace run (line separators included) becomes one space.
const BREAKS = /[\s\p{Cc}]+/gu;
// Format characters (bidi overrides, zero-width joiners) are dropped: they can reorder what a
// human reads without changing a byte they would notice.
const FORMAT = /\p{Cf}/gu;

/** `text` on one line, runs of whitespace and controls as one space, at most `max` chars. */
export function oneLine(text: string, max: number = MAX_TITLE_CHARS): string {
  const flat = text.replace(FORMAT, "").replace(BREAKS, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The tool's severity label as ours; `INFO` is low, anything unknown reads as high. */
export function severityOf(label: string): FindingSeverity {
  const lower = label.trim().toLowerCase();
  if (lower === "info" || lower === "informational") return "low";
  return (FINDING_SEVERITIES as readonly string[]).includes(lower)
    ? (lower as FindingSeverity)
    : "high";
}

/** At most {@link MAX_FINDINGS}, most severe first (stable), and how many were dropped. */
export function keepFindings(all: readonly ScanFinding[]): {
  findings: ScanFinding[];
  truncated: number;
} {
  const rank = (f: ScanFinding) => FINDING_SEVERITIES.indexOf(f.severity);
  const sorted = [...all].sort((a, b) => rank(a) - rank(b));
  return {
    findings: sorted.slice(0, MAX_FINDINGS),
    truncated: Math.max(0, sorted.length - MAX_FINDINGS),
  };
}

/** The prompt-like pattern names found in any of `texts`, each once (D-050). */
export function promptLikeOf(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((t) => findPromptLikeStrings(t)))];
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

const text = z.string();

const skillspectorIssue = z.object({
  id: text,
  severity: text,
  category: text.optional(),
  title: text.optional(),
  name: text.optional(),
  message: text.optional(),
  location: z.object({ file: text.optional(), start_line: z.number().int().optional() }).optional(),
});

/** The documented `--format json` report (README "Machine-readable output"). */
const skillspectorReport = z.object({
  risk_assessment: z.object({
    score: z.number().min(0).max(100),
    recommendation: z.enum(["SAFE", "CAUTION", "DO_NOT_INSTALL"]),
  }),
  issues: z.array(skillspectorIssue),
  metadata: z.object({
    skillspector_version: text.optional(),
    llm_requested: z.boolean(),
    llm_available: z.boolean(),
    llm_error: text.optional(),
  }),
});

/** What the SkillSpector adapter needs from one report. */
export interface SkillspectorReport {
  readonly verdict: Exclude<ScanVerdict, "error">;
  readonly score: number;
  readonly findings: readonly ScanFinding[];
  readonly version: string | null;
  readonly llmRequested: boolean;
  readonly llmAvailable: boolean;
  readonly llmError: string | null;
}

const RECOMMENDATION: Readonly<Record<string, Exclude<ScanVerdict, "error">>> = {
  SAFE: "safe",
  CAUTION: "caution",
  DO_NOT_INSTALL: "unsafe",
};

/** `file` relative to the scanned `root` (or the container's `/scan`), else as given. */
function shownPath(file: string, root: string): string {
  for (const base of [root, "/scan"]) {
    const prefix = base.endsWith("/") ? base : `${base}/`;
    if (file.startsWith(prefix)) return file.slice(prefix.length);
  }
  return file;
}

function issueFinding(i: z.output<typeof skillspectorIssue>, root: string): ScanFinding {
  const title = [i.title, i.name, i.message, i.category, i.id].find((t) => t?.trim()) ?? "";
  const file = i.location?.file;
  const line = i.location?.start_line;
  return {
    id: oneLine(i.id, MAX_ID_CHARS),
    severity: severityOf(i.severity),
    title: oneLine(title),
    ...(file === undefined || file.trim() === ""
      ? {}
      : { file: oneLine(shownPath(file, root), MAX_FILE_CHARS) }),
    ...(line !== undefined && line >= 1 ? { line } : {}),
  };
}

/**
 * One `skillspector scan --format json` stdout. The verdict is the tool's
 * `recommendation` (`SAFE → safe`, `CAUTION → caution`, `DO_NOT_INSTALL → unsafe`), never
 * re-derived from the score. `root` is the scanned directory, stripped from finding paths.
 */
export function parseSkillspectorReport(
  stdout: string,
  root: string,
): Result<SkillspectorReport, string> {
  const parsed = skillspectorReport.safeParse(parseJson(stdout));
  if (!parsed.success) return err(UNREADABLE_OUTPUT);
  const { risk_assessment: risk, issues, metadata } = parsed.data;
  return ok({
    verdict: RECOMMENDATION[risk.recommendation] ?? "safe",
    score: risk.score,
    findings: issues.map((i) => issueFinding(i, root)),
    version:
      metadata.skillspector_version === undefined
        ? null
        : oneLine(metadata.skillspector_version, MAX_ID_CHARS),
    llmRequested: metadata.llm_requested,
    llmAvailable: metadata.llm_available,
    llmError: metadata.llm_error === undefined ? null : oneLine(metadata.llm_error),
  });
}

const contractFinding = z.object({
  id: text,
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: text,
  file: text.optional(),
  line: z.number().int().positive().optional(),
});

/** `jev-cops.scan/1`: what a `command` scanner prints on stdout (README "The command contract"). */
const contractDocument = z.object({
  schema: z.literal("jev-cops.scan/1"),
  verdict: z.enum(["safe", "caution", "unsafe", "error"]),
  score: z.number().min(0).max(100).nullable().optional(),
  findings: z.array(contractFinding).optional(),
  tool: text.min(1).optional(),
  version: text.nullable().optional(),
  error: text.nullable().optional(),
  network: z.enum(SCAN_NETWORKS as [ScanNetwork, ...ScanNetwork[]]).optional(),
});

/** What the `command` adapter needs from one `jev-cops.scan/1` document. */
export interface ContractReport {
  readonly verdict: ScanVerdict;
  readonly score: number | null;
  readonly findings: readonly ScanFinding[];
  readonly tool: string | null;
  readonly version: string | null;
  readonly error: string | null;
  readonly network: ScanNetwork | null;
}

function contractFindingOf(f: z.output<typeof contractFinding>): ScanFinding {
  return {
    id: oneLine(f.id, MAX_ID_CHARS),
    severity: f.severity,
    title: oneLine(f.title),
    ...(f.file === undefined ? {} : { file: oneLine(f.file, MAX_FILE_CHARS) }),
    ...(f.line === undefined ? {} : { line: f.line }),
  };
}

const lineOrNull = (v: string | null | undefined, max: number) =>
  v === undefined || v === null ? null : oneLine(v, max);

/** One `command` scanner's stdout, validated against `jev-cops.scan/1`. */
export function parseContractOutput(stdout: string): Result<ContractReport, string> {
  const parsed = contractDocument.safeParse(parseJson(stdout));
  if (!parsed.success) return err(UNREADABLE_OUTPUT);
  const d = parsed.data;
  return ok({
    verdict: d.verdict,
    score: d.score ?? null,
    findings: (d.findings ?? []).map(contractFindingOf),
    tool: lineOrNull(d.tool, MAX_ID_CHARS),
    version: lineOrNull(d.version, MAX_ID_CHARS),
    error: lineOrNull(d.error, MAX_TITLE_CHARS),
    network: d.network ?? null,
  });
}
