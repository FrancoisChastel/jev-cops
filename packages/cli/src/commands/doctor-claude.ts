/**
 * `cops doctor`, Claude Code around the hook (PLAN-M1 §4.4, D-076): `claude` on PATH and
 * its version against the docs-verified one and the one recorded in
 * `~/.jev-cops/claude-code.json`, the hook's local log, and workspace trust of the cwd,
 * read from `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json` (permissions
 * docs, "What runs before you trust a folder"). Read-only: the doctor never records the
 * version itself; `cops install claude-code` does.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_CODE_STATE_FILE,
  hookLogPath,
  readHarnessVersion,
} from "@jev-cops/adapter-claude-code";
import { isRecord } from "./doctor-settings.ts";
import { type Check, check, type DoctorEnv } from "./doctor-types.ts";

const GROUP = "claude-code";
/** The Claude Code release the adapter's docs review was done against (docs/adapters.md). */
export const DOCS_VERIFIED_VERSION = "2.1.285";
/** Below this a hook `ask` can override `permissions.deny` (#39344, fixed in 2.1.101). */
export const MIN_SAFE_VERSION = "2.1.101";
/** Past this size the local hook log warns: the hook has been deciding alone a lot. */
export const LOG_WARN_BYTES = 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

/** `major.minor.patch` of a version string, or null. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function versionVerdict(version: string): Check {
  const v = parseVersion(version) ?? [0, 0, 0];
  if (compareVersions(v, parseVersion(MIN_SAFE_VERSION) ?? []) < 0) {
    return check(
      GROUP,
      "claude version",
      "fail",
      `${version} is below ${MIN_SAFE_VERSION}: a hook ask can override a permissions.deny rule there (#39344); update Claude Code`,
    );
  }
  if (version !== DOCS_VERIFIED_VERSION) {
    return check(
      GROUP,
      "claude version",
      "warn",
      `${version}; the adapter was verified against ${DOCS_VERIFIED_VERSION}: check the changelog for hook changes (docs/adapters.md#claude-code)`,
    );
  }
  return check(GROUP, "claude version", "ok", `${version} (docs-verified)`);
}

/** `claude` on PATH and `claude --version`; `version` is null when unknown. */
export async function claudeVersionChecks(
  e: DoctorEnv,
): Promise<{ checks: Check[]; version: string | null }> {
  const path = e.which("claude");
  if (path === null) {
    const detail =
      "not on PATH: its version is not checked (Claude Code started another way, e.g. from VS Code, is not verified)";
    return { checks: [check(GROUP, "claude on PATH", "warn", detail)], version: null };
  }
  const found = check(GROUP, "claude on PATH", "ok", path);
  const res = await e.run({
    argv: [path, "--version"],
    env: e.env,
    cwd: e.cwd,
    stdin: "",
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const parsed = res.exitCode === 0 ? parseVersion(res.stdout) : null;
  if (parsed === null) {
    const why = res.error ?? `exit ${res.exitCode ?? "timeout"}`;
    return {
      checks: [
        found,
        check(GROUP, "claude version", "warn", `\`claude --version\` gave no version (${why})`),
      ],
      version: null,
    };
  }
  const version = parsed.join(".");
  return { checks: [found, versionVerdict(version)], version };
}

/** The version recorded for the hook's `harness_version` against the installed one. */
export function recordedVersionCheck(home: string, installed: string | null): Check {
  const path = join(home, ".jev-cops", CLAUDE_CODE_STATE_FILE);
  if (!existsSync(path)) {
    return check(
      GROUP,
      "recorded version",
      "warn",
      `${path} is missing: the hook omits harness_version; \`cops install claude-code\` records it (doctor never writes)`,
    );
  }
  const recorded = readHarnessVersion(home);
  if (recorded === null)
    return check(
      GROUP,
      "recorded version",
      "warn",
      `${path} is unreadable or invalid: the hook omits harness_version`,
    );
  if (installed === null || installed === recorded) {
    return check(GROUP, "recorded version", "ok", `${recorded} in ${path}`);
  }
  return check(
    GROUP,
    "recorded version",
    "warn",
    `${path} says ${recorded}, claude is ${installed}: the hook reports the old version; re-run \`cops install claude-code\``,
  );
}

/** The hook's local log: absent, its size and line count, a warning past {@link LOG_WARN_BYTES}. */
export function hookLogCheck(home: string): Check {
  const path = hookLogPath(home);
  if (!existsSync(path))
    return check(GROUP, "hook log", "ok", `no ${path}: the hook never had to decide alone`);
  const size = statSync(path).size;
  if (size > LOG_WARN_BYTES) {
    return check(
      GROUP,
      "hook log",
      "warn",
      `${path} is ${(size / LOG_WARN_BYTES).toFixed(1)} MB: the hook often decided alone (daemon unreachable, fail-open reads, lost reports); read it`,
    );
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "").length;
  return check(
    GROUP,
    "hook log",
    "ok",
    `${lines} lines (${size} bytes) in ${path}: failures the hook handled alone`,
  );
}

function globalConfigPath(e: DoctorEnv): string {
  const configDir = e.env.CLAUDE_CONFIG_DIR;
  const inConfigDir = configDir ? join(configDir, ".claude.json") : null;
  return inConfigDir !== null && existsSync(inConfigDir)
    ? inConfigDir
    : join(e.home, ".claude.json");
}

function ancestors(dir: string): string[] {
  const up = dirname(dir);
  return up === dir ? [dir] : [dir, ...ancestors(up)];
}

/** The trust key for `dir`: its repository root, else itself or a trusted parent (permissions docs). */
function trustedKey(
  projects: Record<string, unknown>,
  dir: string,
): { key: string | null; repo: string | null } {
  const accepted = (d: string) => {
    const entry = projects[d];
    return isRecord(entry) && entry.hasTrustDialogAccepted === true;
  };
  const chain = ancestors(dir);
  const repo = chain.find((d) => existsSync(join(d, ".git"))) ?? null;
  if (repo !== null) return { key: accepted(repo) ? repo : null, repo };
  return { key: chain.find(accepted) ?? null, repo: null };
}

function readProjects(path: string): Record<string, unknown> | string {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const projects = isRecord(value) ? value.projects : undefined;
    return isRecord(projects) ? projects : {};
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

const HELD_BACK =
  "interactive sessions run no hook, jev-cops included, until you accept the workspace trust dialog (-p runs count as trusted)";

/** Whether interactive sessions in `dir` run hooks at all (hooks#workspace-trust). */
export function trustCheck(e: DoctorEnv, dir: string): Check {
  if (dir === e.home) {
    return check(
      GROUP,
      "workspace trust",
      "warn",
      `${dir} is the home directory: Claude Code keeps its trust for one session only, so each interactive session here asks again; until then no hook runs`,
    );
  }
  const path = globalConfigPath(e);
  if (!existsSync(path))
    return check(
      GROUP,
      "workspace trust",
      "warn",
      `no ${path}, so ${dir} was never trusted: ${HELD_BACK}`,
    );
  const projects = readProjects(path);
  if (typeof projects === "string") {
    return check(
      GROUP,
      "workspace trust",
      "warn",
      `cannot read ${path} (${projects}): trust of ${dir} unknown; ${HELD_BACK}`,
    );
  }
  const { key, repo } = trustedKey(projects, dir);
  if (key !== null)
    return check(
      GROUP,
      "workspace trust",
      "ok",
      `${dir} is trusted (projects["${key}"] in ${path})`,
    );
  const need = repo === null ? dir : `${repo} (its repository root)`;
  return check(GROUP, "workspace trust", "warn", `${need} is not trusted in ${path}: ${HELD_BACK}`);
}
