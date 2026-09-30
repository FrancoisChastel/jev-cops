import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type ContextConfigInput,
  deepFreeze,
  err,
  mergeConfig,
  ok,
  type PolicyConfigInput,
  type Result,
} from "@jev-cops/core";
import { z } from "zod";
import {
  type AuditConfig,
  auditConfig,
  auditFileSchema,
  DEFAULT_AUDIT_TABLE,
  resolveAuditPaths,
} from "./config-audit.ts";
import {
  coreShapeProblems,
  getIn,
  isTable,
  setIn,
  type Table,
  tightenOnly,
} from "./config-rules.ts";
import { DEFAULT_GIT_PROBE_TIMEOUT_MS } from "./git-probe.ts";
import { DEFAULT_HOLD_TOKEN_TTL_MS } from "./hold-tokens.ts";

export type { AuditConfig, AuditForward, SyslogSettings } from "./config-audit.ts";

/** `observe`: log every verdict, return `allow` (spec M4 observe-only). `enforce`: return as is. */
export type EnforcementMode = "observe" | "enforce";
/** Semantic judge providers the daemon can build from config (D-004). */
export const JUDGE_PROVIDERS = ["off", "mock", "jev", "openrouter", "vercel-ai"] as const;
export type JudgeProviderName = (typeof JUDGE_PROVIDERS)[number];

/** A loopback HTTP bind; port 0 picks a free port. */
export interface HttpBind {
  readonly host: string;
  readonly port: number;
}

/** The resolved `cops.toml`: absolute paths, camelCase, defaults filled in. */
export interface DaemonConfig {
  readonly daemon: {
    /** The agent-facing socket, the one a sandbox mounts. */
    readonly socket: string;
    /** The human-only socket (budget reset); never mount it into a sandbox (H1). */
    readonly adminSocket: string;
    /** Null: no HTTP listener (the default). */
    readonly http: HttpBind | null;
    /** `~`/`$HOME` for event normalization (D-003). */
    readonly home: string;
    /** Past this a `/v1/judge` request answers 504 (T3); above the judge timeout. */
    readonly judgeDeadlineMs: number;
    /** How long the hold token of a `hold` shown to a human stays valid (T7/T8). */
    readonly holdTokenTtlMs: number;
    /** Budget for deriving `env.git` from an event's cwd, all git calls included (D-058). */
    readonly gitProbeTimeoutMs: number;
    /** The harness hook binary (`cops install` sets it); protected like the daemon's own. */
    readonly hookBinary: string | null;
  };
  readonly policies: { readonly dir: string };
  readonly judge: {
    readonly provider: JudgeProviderName;
    readonly model: string | null;
    readonly timeoutMs: number;
    readonly cacheTtlMs: number;
  };
  readonly context: ContextConfigInput;
  readonly policy: PolicyConfigInput;
  readonly audit: AuditConfig;
  readonly store: { readonly path: string };
  readonly enforcement: { readonly mode: EnforcementMode };
}

/** Thrown for unreadable, unparseable or invalid config; the message names the file. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_PORT = 65_535;

/**
 * Parses `host:port` (IPv6 as `[::1]:port`) and accepts loopback hosts only, so the
 * HTTP listener can never be reached from another machine or the sandbox network (T13).
 */
export function parseHttpBind(text: string): Result<HttpBind, string> {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(text.trim());
  if (match === null) return err(`http must be "host:port", got "${text}"`);
  const host = match[1] ?? match[2] ?? "";
  const port = Number(match[3]);
  if (!LOOPBACK.has(host)) return err(`http must bind a loopback address, got "${host}"`);
  if (!Number.isInteger(port) || port > MAX_PORT) return err(`invalid port in "${text}"`);
  return ok({ host, port });
}

const text = z.string().min(1);
const table = z.custom<Table>(isTable, { error: "expected a table" });

/** One `cops.toml` file. Strict: an unknown key is an error, never ignored. */
const fileSchema = z.strictObject({
  daemon: z
    .strictObject({
      socket: text.optional(),
      admin_socket: text.optional(),
      http: z.union([text, z.literal(false)]).optional(),
      home: text.optional(),
      judge_deadline_ms: z.int().positive().optional(),
      hold_token_ttl_ms: z.int().positive().optional(),
      git_probe_timeout_ms: z.int().positive().optional(),
      hook_binary: text.optional(),
    })
    .optional(),
  policies: z.strictObject({ dir: text.optional() }).optional(),
  judge: z
    .strictObject({
      provider: z.enum(JUDGE_PROVIDERS).optional(),
      model: text.optional(),
      timeout_ms: z.int().positive().optional(),
      cache_ttl_ms: z.int().nonnegative().optional(),
    })
    .optional(),
  context: table.optional(),
  policy: table.optional(),
  audit: auditFileSchema.optional(),
  store: z.strictObject({ path: text.optional() }).optional(),
  enforcement: z.strictObject({ mode: z.enum(["observe", "enforce"]).optional() }).optional(),
});

/** The spec defaults as a file-shaped table (paths still `~`-relative). */
const DEFAULT_TABLE: Table = deepFreeze({
  daemon: {
    socket: "~/.jev-cops/copsd.sock",
    admin_socket: "~/.jev-cops/copsd-admin.sock",
    http: false,
    judge_deadline_ms: 12_000,
    hold_token_ttl_ms: DEFAULT_HOLD_TOKEN_TTL_MS,
    git_probe_timeout_ms: DEFAULT_GIT_PROBE_TIMEOUT_MS,
  },
  judge: { provider: "off", timeout_ms: 10_000, cache_ttl_ms: 600_000 },
  context: {},
  policy: {},
  audit: DEFAULT_AUDIT_TABLE,
  store: { path: "~/.jev-cops/cops.sqlite" },
  enforcement: { mode: "observe" },
});

const SECRET_KEY = /api[_-]?key|token|secret|password/i;

/** The starter set's manifest, resolved to find its directory. */
const STARTER_POLICIES_MANIFEST = "@jev-cops/policies/package.json";

/** Resolves a package specifier to a file path; throws when the package is not installed. */
export type ResolvePackage = (specifier: string) => string;

const resolveFromHere: ResolvePackage = (specifier) => Bun.resolveSync(specifier, import.meta.dir);

/**
 * The directory of the installed starter set, `@jev-cops/policies`, resolved from this
 * module: `node_modules/@jev-cops/policies` in an npm or bun install, the workspace link to
 * `policies/` in the repository. Null when it is not installed or not a directory; a
 * compiled `copsd` has no `node_modules` to resolve from, so it always gets null.
 */
export function installedPoliciesDir(
  resolvePackage: ResolvePackage = resolveFromHere,
): string | null {
  let manifest: string;
  try {
    manifest = resolvePackage(STARTER_POLICIES_MANIFEST);
  } catch {
    return null;
  }
  const dir = dirname(manifest);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * `[policies] dir` when no config file sets it: the installed starter set, else
 * `<cwd>/policies` (a source checkout, or a compiled `copsd` run from one). Never empty in
 * effect: a directory that is missing or holds no policy fails the daemon's boot.
 */
export function defaultPoliciesDir(
  cwd: string,
  installed: string | null = installedPoliciesDir(),
): string {
  return installed ?? join(cwd, "policies");
}

function expandPath(path: string, base: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

const PATH_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["daemon", "socket"],
  ["daemon", "admin_socket"],
  ["daemon", "home"],
  ["daemon", "hook_binary"],
  ["policies", "dir"],
  ["store", "path"],
];

/** Resolves every path-valued key of one file against that file's directory. */
function resolvePaths(t: Table, base: string, home: string): Table {
  let withPaths = t;
  for (const [section, key] of PATH_KEYS) {
    const value = getIn(t, [section, key]);
    if (typeof value === "string") {
      withPaths = setIn(withPaths, [section, key], expandPath(value, base, home));
    }
  }
  const audit = withPaths.audit;
  if (!isTable(audit)) return withPaths;
  return { ...withPaths, audit: resolveAuditPaths(audit, (p) => expandPath(p, base, home)) };
}

function validate(raw: unknown, source: string): Table {
  const judge = isTable(raw) ? raw.judge : undefined;
  if (isTable(judge) && Object.keys(judge).some((k) => SECRET_KEY.test(k))) {
    throw new ConfigError(
      `${source}: API keys come from the environment only, never from the config file (D-044)`,
    );
  }
  const parsed = fileSchema.safeParse(raw);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const data = parsed.success ? (parsed.data as Table) : {};
  for (const section of ["context", "policy"] as const) {
    const sec = data[section];
    if (isTable(sec)) problems.push(...coreShapeProblems(section, sec));
  }
  if (problems.length > 0)
    throw new ConfigError(`${source}: invalid config: ${problems.join("; ")}`);
  const daemon = data.daemon;
  if (isTable(daemon) && typeof daemon.http === "string") {
    const bind = parseHttpBind(daemon.http);
    if (!bind.ok) throw new ConfigError(`${source}: daemon.${bind.error}`);
  }
  return data;
}

/** Reads, parses (Bun's TOML) and validates one file; paths resolved against its dir. */
export function readConfigFile(path: string, home: string): Table {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`${path}: cannot read: ${(cause as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(source);
  } catch (cause) {
    throw new ConfigError(`${path}: invalid TOML: ${(cause as Error).message}`);
  }
  return resolvePaths(validate(raw, path), dirname(path), home);
}

/** Where to look; every field defaults to the real process. */
export interface LoadConfigOptions {
  /** `--config <path>`: must exist. */
  configPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Expands `~` in paths; default `os.homedir()`. */
  home?: string;
  /**
   * The starter set's directory for the `[policies] dir` default; default
   * {@link installedPoliciesDir}(). Null skips it, so the default is `<cwd>/policies`.
   */
  installedPolicies?: string | null;
}

/** The resolved config, the files it came from (lowest first) and rejected repo keys. */
export interface LoadedConfig {
  config: DaemonConfig;
  sources: string[];
  rejected: string[];
  /**
   * The files the daemon's own settings come from, absolute, whether or not they exist
   * yet: the user file, `$JEV_COPS_CONFIG`, `--config`. The repo override is not one (it
   * may only tighten, and `config-tamper` guards every `.cops.toml`). The daemon
   * protects these: a file created later is loaded at the next start.
   */
  inputs: string[];
}

function toConfig(t: Table, home: string, policiesDir: string): DaemonConfig {
  const f = t as z.output<typeof fileSchema>;
  const http = f.daemon?.http;
  const bind = typeof http === "string" ? parseHttpBind(http) : null;
  return deepFreeze({
    daemon: {
      socket: f.daemon?.socket ?? "",
      adminSocket: f.daemon?.admin_socket ?? "",
      http: bind?.ok === true ? bind.value : null,
      home: f.daemon?.home ?? home,
      judgeDeadlineMs: f.daemon?.judge_deadline_ms ?? 12_000,
      holdTokenTtlMs: f.daemon?.hold_token_ttl_ms ?? DEFAULT_HOLD_TOKEN_TTL_MS,
      gitProbeTimeoutMs: f.daemon?.git_probe_timeout_ms ?? DEFAULT_GIT_PROBE_TIMEOUT_MS,
      hookBinary: f.daemon?.hook_binary ?? null,
    },
    policies: { dir: f.policies?.dir ?? policiesDir },
    judge: {
      provider: f.judge?.provider ?? "off",
      model: f.judge?.model ?? null,
      timeoutMs: f.judge?.timeout_ms ?? 10_000,
      cacheTtlMs: f.judge?.cache_ttl_ms ?? 600_000,
    },
    context: (f.context ?? {}) as ContextConfigInput,
    policy: (f.policy ?? {}) as PolicyConfigInput,
    audit: resolvedAudit(f.audit),
    store: { path: f.store?.path ?? "" },
    enforcement: { mode: f.enforcement?.mode ?? "observe" },
  });
}

/** `[audit]` of the merged layers; a forward that cannot work is a {@link ConfigError}. */
function resolvedAudit(t: z.output<typeof auditFileSchema> | undefined): AuditConfig {
  const audit = auditConfig(t);
  if (!audit.ok) throw new ConfigError(`invalid config: ${audit.error}`);
  return audit.value;
}

function existing(path: string | undefined): string | null {
  return path !== undefined && path !== "" && existsSync(path) ? path : null;
}

/**
 * Loads `cops.toml` layered lowest to highest: defaults, the user file
 * (`~/.config/jev-cops/cops.toml`), the repo override (`./.cops.toml`, which may
 * only tighten: its other keys are dropped and reported), `$JEV_COPS_CONFIG`, then
 * `--config`. Objects merge, scalars replace. API keys are refused (env only, D-044).
 * `[policies] dir` unset in every file means {@link defaultPoliciesDir}.
 * Throws {@link ConfigError} on unreadable, invalid TOML or unknown keys.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  if (opts.configPath !== undefined && !existsSync(opts.configPath)) {
    throw new ConfigError(`${opts.configPath}: config file not found`);
  }
  const userPath = join(home, ".config", "jev-cops", "cops.toml");
  const user = existing(userPath);
  const repo = existing(join(cwd, ".cops.toml"));
  const envFile = existing(env.JEV_COPS_CONFIG);
  let merged = resolvePaths(DEFAULT_TABLE, cwd, home);
  const sources: string[] = [];
  const rejected: string[] = [];
  const apply = (path: string | null, tighten: boolean) => {
    if (path === null) return;
    const file = readConfigFile(path, home);
    const layer = tighten ? tightenOnly(file, merged, path) : { kept: file, rejected: [] };
    merged = mergeConfig<Table>(merged, layer.kept);
    rejected.push(...layer.rejected);
    sources.push(path);
  };
  apply(user, false);
  apply(repo, true);
  apply(envFile, false);
  apply(opts.configPath ?? null, false);
  const named = [env.JEV_COPS_CONFIG, opts.configPath].filter(
    (p): p is string => p !== undefined && p !== "",
  );
  // Resolved like the reads above: against the process's cwd.
  const inputs = [userPath, ...named.map((p) => resolve(p))];
  const installed =
    opts.installedPolicies === undefined ? installedPoliciesDir() : opts.installedPolicies;
  const policiesDir = defaultPoliciesDir(cwd, installed);
  return { config: toConfig(merged, home, policiesDir), sources, rejected, inputs };
}

/** The defaults as resolved for the current user and working directory. Frozen. */
export const DEFAULT_DAEMON_CONFIG: DaemonConfig = toConfig(
  resolvePaths(DEFAULT_TABLE, process.cwd(), homedir()),
  homedir(),
  defaultPoliciesDir(process.cwd()),
);
