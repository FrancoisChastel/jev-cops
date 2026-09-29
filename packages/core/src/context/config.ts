import { homedir } from "node:os";

/** Names of the four spec sequence patterns (spec §Context model, Sequence). */
export const SEQUENCE_PATTERNS = [
  "secret-read-then-net",
  "failures-then-privilege",
  "write-executable-then-exec",
  "new-host-after-secret",
] as const;

/** One of {@link SEQUENCE_PATTERNS}. */
export type SequencePatternName = (typeof SEQUENCE_PATTERNS)[number];

/** Credential class of a target host; anything not in the map is `unknown`. */
export type HostClass = "prod" | "staging" | "dev";

/** Risk budget: spec §Verdict ladder "Risk budget" (D-009). */
export interface BudgetConfig {
  limit: number;
  /** Points returned per whole minute of inactivity. */
  decayPerMinute: number;
  /** Event cost is `round(risk * costScale)`. */
  costScale: number;
  /** Fraction of `limit` at which every verdict is raised one step. */
  raiseAt: number;
  /** Fraction of `limit` at which every non-trivial action is held. */
  holdAt: number;
  /** Cost multiplier per repeated hold of the same precedent key (T7). */
  holdRepeatFactor: number;
}

/** Sequence feature: windows and pattern weights. */
export interface SequenceConfig {
  windowMs: number;
  secretNetWindowMs: number;
  failuresBeforePrivilege: number;
  weights: Record<SequencePatternName, number>;
}

/** Environment feature: additive exposure weights, clamped to 1. */
export interface EnvironmentConfig {
  weights: {
    defaultBranch: number;
    cwdOutsideRepo: number;
    dirtyTree: number;
    headless: number;
    noSandbox: number;
  };
  hostClassWeights: Record<HostClass | "unknown", number>;
  /** Host (lower-case) → credential class; hosts absent here are `unknown`. */
  hostClasses: Record<string, HostClass>;
  /** Branch names treated as default when `env.git.default_branch` is absent. */
  fallbackDefaultBranches: string[];
}

/** Taint token rules. */
export interface TaintConfig {
  /** Candidates and matches shorter than this are ignored. */
  minLength: number;
  maxCandidatesPerEvent: number;
  /** Taint of strings found in tool output, unless the caller passes the source's own. */
  outputTaint: number;
}

/** Deterministic scope layer. */
export interface ScopeConfig {
  /** Directories that are always in scope (scratch space). */
  tmpDirs: string[];
  /** Lockfile basename → registry hosts it implies (subdomains included). */
  registries: Record<string, string[]>;
  /** Score when an exec/spawn/other names no path and no host. */
  noTargets: number;
  /** Score for a host when the task allowlist is empty. */
  noAllowlist: number;
  /** Score when the tool is outside the task's expected set. */
  unexpectedTool: number;
  /** Score contributed by an opaque construct, whose targets are unknown. */
  opaque: number;
}

/** Reversibility classification inputs. */
export interface ReversibilityConfig {
  irreversibleVerbs: string[];
  netWriteMethods: string[];
  /** Regex source (case-insensitive) matching env/argument names that carry credentials. */
  credentialName: string;
}

/** Secret detection: path globs (spec §Session case file). */
export interface SecretsConfig {
  pathGlobs: string[];
}

/** Every threshold, weight and window the context engine uses. One place to tune (D-009). */
export interface ContextConfig {
  /** What `~` expands to in secret globs: daemon config, never the event (D-003). */
  home: string;
  budget: BudgetConfig;
  sequence: SequenceConfig;
  environment: EnvironmentConfig;
  taint: TaintConfig;
  scope: ScopeConfig;
  reversibility: ReversibilityConfig;
  secrets: SecretsConfig;
}

/** Recursive partial; arrays and scalars replace, objects merge. */
export type ContextConfigInput = DeepPartial<ContextConfig>;

/** Recursive partial used by every mergeable config: arrays and scalars replace, objects merge. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

const MINUTE_MS = 60_000;
const NPM = ["npmjs.org"];
const PYPI = ["pypi.org"];
const GO = ["proxy.golang.org", "github.com"];

/** Freezes `value` and everything reachable from it; returns the same reference. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Spec defaults (D-009). Deeply frozen: derive variants with {@link resolveContextConfig}. */
export const DEFAULT_CONTEXT_CONFIG: Readonly<ContextConfig> = deepFreeze({
  home: homedir(),
  budget: {
    limit: 100,
    decayPerMinute: 10,
    costScale: 20,
    raiseAt: 0.8,
    holdAt: 1.0,
    holdRepeatFactor: 2,
  },
  sequence: {
    windowMs: 5 * MINUTE_MS,
    secretNetWindowMs: 2 * MINUTE_MS,
    failuresBeforePrivilege: 3,
    weights: {
      "secret-read-then-net": 1.0,
      "failures-then-privilege": 0.7,
      "write-executable-then-exec": 0.8,
      "new-host-after-secret": 0.9,
    },
  },
  environment: {
    weights: {
      defaultBranch: 0.3,
      cwdOutsideRepo: 0.2,
      dirtyTree: 0.1,
      headless: 0.2,
      noSandbox: 0.1,
    },
    hostClassWeights: { prod: 0.3, staging: 0.15, dev: 0, unknown: 0.05 },
    hostClasses: {},
    fallbackDefaultBranches: ["main", "master"],
  },
  taint: { minLength: 4, maxCandidatesPerEvent: 500, outputTaint: 1 },
  scope: {
    tmpDirs: ["/tmp"],
    registries: {
      "package-lock.json": NPM,
      "npm-shrinkwrap.json": NPM,
      "pnpm-lock.yaml": NPM,
      "bun.lock": NPM,
      "bun.lockb": NPM,
      "yarn.lock": ["registry.yarnpkg.com", ...NPM],
      "poetry.lock": PYPI,
      "Pipfile.lock": PYPI,
      "uv.lock": PYPI,
      "requirements.txt": PYPI,
      "Cargo.lock": ["crates.io"],
      "go.sum": GO,
      "go.mod": GO,
    },
    noTargets: 0.7,
    noAllowlist: 0.5,
    unexpectedTool: 0.5,
    opaque: 0.7,
  },
  reversibility: {
    irreversibleVerbs: ["force", "hard", "irreversible", "privilege"],
    netWriteMethods: ["POST", "PUT", "DELETE", "PATCH", "OTHER"],
    credentialName: "token|secret|passw|api[_-]?key|credential|private[_-]?key|^aws_",
  },
  secrets: {
    // The spec's `**/.env*`, narrowed so `.environment.md`-style docs are not secrets.
    pathGlobs: ["**/.env{,.*,-*,_*,rc}", "**/*.pem", "**/*.key", "~/.ssh/**", "~/.aws/**"],
  },
} satisfies ContextConfig);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const keys = new Set([...Object.keys(base), ...Object.keys(patch)]);
  const entries = [...keys]
    .filter((key) => !UNSAFE_KEYS.has(key))
    .map((key) => [key, merge(base[key], Object.hasOwn(patch, key) ? patch[key] : undefined)]);
  return Object.fromEntries(entries);
}

/**
 * `base` deep-merged with `patch` as a fresh object: objects merge key by key, arrays and
 * scalars replace, `__proto__`/`constructor`/`prototype` keys are dropped. Neither input
 * is touched. Shared by every config module so all of them merge the same way.
 */
export function mergeConfig<T>(base: T, patch: DeepPartial<T> = {} as DeepPartial<T>): T {
  return merge(base, patch) as T;
}

/**
 * The defaults deep-merged with `partial`: objects merge key by key, arrays and scalars
 * replace. Returns a fresh object; neither the defaults nor `partial` are touched, and
 * `__proto__`/`constructor`/`prototype` keys are dropped.
 */
export function resolveContextConfig(partial: ContextConfigInput = {}): ContextConfig {
  return mergeConfig<ContextConfig>(DEFAULT_CONTEXT_CONFIG, partial);
}
