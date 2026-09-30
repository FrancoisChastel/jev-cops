/**
 * The scanner contract (PLAN-SETUP §4.1): what a security scanner answers about a skill,
 * plugin or MCP server before an agent installs it. Every adapter maps its tool's output
 * onto {@link ScanResult}; nothing downstream knows which tool ran.
 */

/** The tool's recommendation, never re-derived from its score. `error`: no usable answer. */
export type ScanVerdict = "safe" | "caution" | "unsafe" | "error";

/** A finding's severity, lower-cased from the tool's own label. */
export type FindingSeverity = "low" | "medium" | "high" | "critical";

/** Every severity, most severe first (the order findings are kept in). */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = Object.freeze([
  "critical",
  "high",
  "medium",
  "low",
]);

/** One finding, flattened for a human: every text field is one bounded line. */
export interface ScanFinding {
  /** The tool's rule or issue id (e.g. SkillSpector `E2`). */
  readonly id: string;
  readonly severity: FindingSeverity;
  /** One line, at most 200 characters. */
  readonly title: string;
  /** Path relative to the scanned directory, when the tool names one. */
  readonly file?: string;
  /** 1-based line, when the tool names one. */
  readonly line?: number;
}

/** How the scan ran: `static` keeps file contents local; `llm` may send them to a provider. */
export type ScanMode = "static" | "llm";

/**
 * What the adapter knows left the machine: `none`, dependency names and versions only
 * (SkillSpector SC4 queries OSV.dev even with `--no-llm`), or file contents to a provider.
 */
export type ScanNetwork = "none" | "osv-only" | "provider";

/** Every network class, narrowest first. */
export const SCAN_NETWORKS: readonly ScanNetwork[] = Object.freeze([
  "none",
  "osv-only",
  "provider",
]);

/** One scan's answer. Scanners never throw: every failure is `verdict: "error"`. */
export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** 0..100 as the tool reports it; null when it has none (or on error). */
  readonly score: number | null;
  /** At most {@link MAX_FINDINGS}, most severe first; the rest are counted in `truncated`. */
  readonly findings: readonly ScanFinding[];
  readonly truncated: number;
  /** The tool's name, e.g. `skillspector`. */
  readonly tool: string;
  readonly version: string | null;
  readonly mode: ScanMode;
  readonly durationMs: number;
  /** Set for `verdict: "error"` only: one line, at most 200 characters. */
  readonly error: string | null;
  readonly network: ScanNetwork;
  /**
   * Names of the prompt-like patterns (core `findPromptLikeStrings`, D-050) found in the
   * finding titles or the error line: text a skill author may have aimed at the human or
   * at a model. Empty when none. Recorded, never used to change the verdict.
   */
  readonly promptLike: readonly string[];
  /** For `verdict: "error"` after the tool ran: the last 2 KB of its stderr, else null. */
  readonly stderrTail: string | null;
}

/** Findings kept per result; the rest are only counted. */
export const MAX_FINDINGS = 64;

/**
 * What to scan: a directory or file on this machine. A URL is only ever fetched by the
 * daemon (PLAN-SETUP §4.3); a scanner given one answers `error` without running anything.
 */
export type ScanTarget =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "url"; readonly url: string; readonly fetchedBy: "daemon" };

/** An environment to read variables from: the daemon's own, never the agent's. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Per-scan bounds. */
export interface ScanOptions {
  /** Hard deadline for the whole scan; the process group is killed at it. */
  readonly deadlineMs: number;
  /** Aborting it kills the scan (answers `error: "aborted"`). */
  readonly signal?: AbortSignal;
  /** Where variables come from for this scan (default: the factory's env). */
  readonly env?: Env;
  /** The scan's working directory (default: the scanned directory, or a file's parent). */
  readonly cwd?: string;
}

/** Whether a scanner can run at all, and the tool's version when it can. */
export type Availability =
  | { readonly ok: true; readonly version: string | null }
  | { readonly ok: false; readonly reason: string };

/** The adapters `createScanner` builds. */
export type ScannerName = "none" | "skillspector" | "command";

/** A security scanner. `scan` never throws; any failure is a result with `verdict: "error"`. */
export interface Scanner {
  readonly name: ScannerName;
  available(): Promise<Availability>;
  scan(target: ScanTarget, opts: ScanOptions): Promise<ScanResult>;
}

/** SkillSpector through its container image (built locally from the repo's Dockerfile). */
export interface SkillspectorDocker {
  readonly image: string;
  /** `"none"` adds `--network none` (air-gapped: OSV lookups fall back to the bundled list). */
  readonly network?: "none";
}

/**
 * Which scanner the daemon uses (`[scanner]` in config, S2). Mirrors `@jev-cops/judge`
 * (D-004): the factory never throws, and a missing tool answers `error`.
 */
export type ScannerConfig =
  | { readonly adapter: "none" }
  | {
      readonly adapter: "skillspector";
      /** Absolute path; default `skillspector` on the absolute entries of `PATH`. */
      readonly binary?: string;
      readonly docker?: SkillspectorDocker | null;
      readonly mode?: ScanMode;
      /** Only the flags in `SKILLSPECTOR_EXTRA_FLAGS`; anything else makes every scan an error. */
      readonly extraArgs?: readonly string[];
    }
  | {
      readonly adapter: "command";
      /** argv[0] absolute, or a bare name looked up on the absolute entries of `PATH`. */
      readonly argv: readonly string[];
      readonly mode?: ScanMode;
      /** What the command sends off the machine; default `provider` (assume the widest). */
      readonly network?: ScanNetwork;
    };
