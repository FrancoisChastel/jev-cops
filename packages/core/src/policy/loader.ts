import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "../result.ts";
import { VERDICTS, type Verdict, verdictRank } from "../schema/verdict.ts";
import type { PolicyDefinition } from "./types.ts";

/** Policies that loaded, and one line per module or duplicate that did not. */
export interface LoadedPolicies {
  policies: PolicyDefinition[];
  problems: string[];
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE_FILE = /\.(?:ts|js|mjs)$/;
const SKIPPED_FILE = /(?:\.test\.(?:ts|js|mjs)|\.d\.ts)$/;
const OPTIONAL_FUNCTIONS = ["ask", "detail", "rewrite", "contextNote"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

function isAsync(fn: unknown): boolean {
  return typeof fn === "function" && fn.constructor.name === "AsyncFunction";
}

function rangeProblems(range: unknown): string[] {
  if (range === undefined) return [];
  if (!Array.isArray(range) || range.length !== 2 || !range.every(isVerdict)) {
    return ["range must be two verdicts"];
  }
  const [low, high] = range as [Verdict, Verdict];
  return verdictRank(low) <= verdictRank(high) ? [] : ["range must ascend the verdict ladder"];
}

function identityProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof p.name !== "string" || !KEBAB.test(p.name)) problems.push("name must be kebab-case");
  if (typeof p.version !== "number" || !Number.isInteger(p.version) || p.version < 1) {
    problems.push("version must be an integer >= 1");
  }
  if (typeof p.owner !== "string" || p.owner.trim() === "") {
    problems.push("owner must be a non-empty string");
  }
  return problems;
}

function memberProblems(p: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof p.when !== "function") problems.push("when must be a function");
  else if (isAsync(p.when)) problems.push("when must be synchronous");
  if (typeof p.decide !== "function") problems.push("decide must be a function");
  for (const key of OPTIONAL_FUNCTIONS) {
    if (p[key] !== undefined && typeof p[key] !== "function") {
      problems.push(`${key} must be a function`);
    }
  }
  const reasonOk =
    typeof p.reason === "function" || (typeof p.reason === "string" && p.reason !== "");
  if (!reasonOk) problems.push("reason must be a non-empty string or a function");
  if (p.fallback !== undefined && !isVerdict(p.fallback)) {
    problems.push("fallback must be a verdict");
  }
  return [...problems, ...rangeProblems(p.range)];
}

/**
 * Structural check of a policy module's default export (zod-free, for the loader and the
 * SDK): kebab-case name, integer version >= 1, non-empty owner, synchronous `when`,
 * `decide`, optional functions typed, a non-empty reason, a verdict `fallback`, and a
 * `range` of two verdicts ascending the ladder. Returns a frozen shallow copy.
 */
export function validatePolicy(value: unknown): Result<PolicyDefinition, string[]> {
  if (!isRecord(value)) return err(["policy must be an object"]);
  const problems = [...identityProblems(value), ...memberProblems(value)];
  if (problems.length > 0) return err(problems);
  return ok(Object.freeze({ ...value }) as unknown as PolicyDefinition);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The import specifier for a policy module. With `cacheBust`, a plain path with a
 * `?v=<mtime>-<size>` query: Bun caches modules by specifier, so a changed file gets a new
 * one and an unchanged file keeps its cached module. (Bun 1.3 ignores the query on a
 * `file:` URL, hence the plain path.)
 */
async function specifier(path: string, cacheBust: boolean): Promise<string> {
  if (!cacheBust) return pathToFileURL(path).href;
  const s = await stat(path);
  return `${path}?v=${s.mtimeMs}-${s.size}`;
}

async function importPolicy(
  dir: string,
  file: string,
  cacheBust: boolean,
): Promise<Result<PolicyDefinition, string>> {
  try {
    const mod: unknown = await import(await specifier(join(dir, file), cacheBust));
    if (!isRecord(mod) || mod.default === undefined) return err(`${file}: no default export`);
    const checked = validatePolicy(mod.default);
    return checked.ok ? checked : err(`${file}: ${checked.error.join("; ")}`);
  } catch (cause) {
    return err(`${file}: import failed: ${message(cause)}`);
  }
}

interface Candidate {
  policy: PolicyDefinition;
  file: string;
}

function dedupe(candidates: ReadonlyArray<Candidate>): LoadedPolicies {
  const kept = new Map<string, Candidate>();
  const problems: string[] = [];
  const label = (c: Candidate) => `${c.policy.name}@${c.policy.version} (${c.file})`;
  for (const c of candidates) {
    const prev = kept.get(c.policy.name);
    if (prev === undefined) {
      kept.set(c.policy.name, c);
      continue;
    }
    const [win, lose] = c.policy.version > prev.policy.version ? [c, prev] : [prev, c];
    kept.set(c.policy.name, win);
    problems.push(`duplicate policy ${c.policy.name}: ${label(lose)} ignored, ${label(win)} kept`);
  }
  return { policies: [...kept.values()].map((c) => c.policy), problems };
}

/** Loader options. */
export interface LoadPoliciesOptions {
  /** Re-import files changed since the last load (the daemon's hot reload). */
  cacheBust?: boolean;
}

/**
 * Imports every `*.ts`/`*.js`/`*.mjs` module in `dir` (not recursive; `*.test.*`, `*.d.ts`
 * and fixtures skipped) in file-name order and keeps each default export that passes
 * {@link validatePolicy}. A module that throws on import or fails validation is reported,
 * never fatal. Duplicate names keep the higher version (the earlier file on a tie).
 */
export async function loadPolicies(
  dir: string,
  opts: LoadPoliciesOptions = {},
): Promise<LoadedPolicies> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => CODE_FILE.test(f) && !SKIPPED_FILE.test(f)).sort();
  } catch (cause) {
    return { policies: [], problems: [`cannot read policy directory ${dir}: ${message(cause)}`] };
  }
  const results = await Promise.all(
    files.map(async (file) => ({
      file,
      loaded: await importPolicy(dir, file, opts.cacheBust === true),
    })),
  );
  const candidates = results.flatMap(({ file, loaded }) =>
    loaded.ok ? [{ policy: loaded.value, file }] : [],
  );
  const failures = results.flatMap(({ loaded }) => (loaded.ok ? [] : [loaded.error]));
  const deduped = dedupe(candidates);
  return { policies: deduped.policies, problems: [...failures, ...deduped.problems] };
}
