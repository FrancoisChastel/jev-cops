/**
 * `cops openshell …` argument parsing: strict (an unknown option is a usage error, exit 2),
 * and the compile inputs every subcommand shares (harness layout, task, repo, policies,
 * judge route). Paths in the layout flags are paths inside the sandbox.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadPolicies } from "@jev-cops/core";
import { DEFAULT_DAEMON_CONFIG, loadConfig } from "@jev-cops/daemon";
import {
  type CompiledPolicy,
  type CompileInput,
  compilePolicy,
  defaultLayout,
  HARNESSES,
  type Harness,
  type PolicyRef,
  readRepo,
  renderReport,
  type SandboxLayout,
} from "@jev-cops/openshell";
import { EXIT, type Io } from "../io.ts";

/** `--dry-run` found differences (D-108). */
export const EXIT_CHANGES = 3;

/** copsd's sandbox listener port until the `[openshell]` table exists (PLAN-M2 §4 example). */
export const DEFAULT_JUDGE_PORT = 17_681;

/** Options every `cops openshell` subcommand takes. */
export const COMPILE_OPTIONS = {
  harness: { type: "string" },
  task: { type: "string" },
  repo: { type: "string" },
  "no-repo": { type: "boolean" },
  policies: { type: "string" },
  "judge-port": { type: "string" },
  "no-judge": { type: "boolean" },
  "judge-host": { type: "string", multiple: true },
  home: { type: "string" },
  workspace: { type: "string" },
  "agent-binary": { type: "string", multiple: true },
  "hook-binary": { type: "string" },
  interpreter: { type: "string" },
  extension: { type: "string" },
  "read-write": { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  openshell: { type: "string" },
} as const;

/** The shared options' usage lines. */
export const COMPILE_FLAGS_USAGE = `          [--harness claude-code|pi] [--task text] [--repo dir|--no-repo] [--policies dir]
          [--judge-port n|--no-judge] [--judge-host host]… [--home dir] [--workspace dir]
          [--agent-binary path]… [--hook-binary path] [--interpreter path]
          [--extension path] [--read-write path]…`;

/** Parsed option values (`node:util` parseArgs shape). */
export type Values = Record<string, string | boolean | string[] | undefined>;

/** Strict parse of `argv` with `options`; a message on a usage error. */
export function parse(
  argv: readonly string[],
  options: Record<string, { type: "string" | "boolean"; multiple?: boolean }>,
): { ok: true; values: Values; positionals: string[] } | { ok: false; error: string } {
  try {
    const parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return { ok: true, values: parsed.values as Values, positionals: parsed.positionals };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}

function str(v: Values, key: string): string | null {
  const value = v[key];
  return typeof value === "string" ? value : null;
}

function list(v: Values, key: string): string[] {
  const value = v[key];
  return Array.isArray(value) ? value : [];
}

function layoutOf(harness: Harness, v: Values): SandboxLayout {
  const base = defaultLayout(harness);
  const agents = list(v, "agent-binary");
  return {
    ...base,
    home: str(v, "home") ?? base.home,
    workspace: str(v, "workspace") ?? base.workspace,
    hookBinary: str(v, "hook-binary") ?? base.hookBinary,
    interpreter: str(v, "interpreter") ?? base.interpreter,
    extension: str(v, "extension") ?? base.extension,
    agentBinaries: agents.length > 0 ? agents : base.agentBinaries,
  };
}

function judgeOf(v: Values): { port: number } | null | string {
  if (v["no-judge"] === true) return null;
  const text = str(v, "judge-port");
  if (text === null) return { port: DEFAULT_JUDGE_PORT };
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? { port }
    : `--judge-port must be a TCP port, got "${text}"`;
}

/** The policies directory as copsd resolves it (by default the installed starter set). */
function policiesDir(v: Values): string {
  const given = str(v, "policies");
  if (given !== null) return resolve(given);
  try {
    return loadConfig().config.policies.dir;
  } catch {
    return resolve(DEFAULT_DAEMON_CONFIG.policies.dir);
  }
}

/** Loads the policy set's name, version and range; problems are returned, not fatal. */
export async function loadPolicyRefs(
  v: Values,
): Promise<{ refs: PolicyRef[]; problems: string[] }> {
  const loaded = await loadPolicies(policiesDir(v));
  const refs = loaded.policies.map((p) => ({
    name: p.name,
    version: p.version,
    ...(p.range === undefined ? {} : { range: p.range }),
  }));
  return { refs, problems: loaded.problems };
}

/** The compile input from parsed options, or a usage error. */
export async function compileInputOf(
  v: Values,
): Promise<{ ok: true; input: CompileInput; problems: string[] } | { ok: false; error: string }> {
  const harness = str(v, "harness") ?? "claude-code";
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    return { ok: false, error: `--harness must be one of ${HARNESSES.join(", ")}` };
  }
  const judge = judgeOf(v);
  if (typeof judge === "string") return { ok: false, error: judge };
  const h = harness as Harness;
  const repoDir = v["no-repo"] === true ? null : resolve(str(v, "repo") ?? ".");
  const { refs, problems } = await loadPolicyRefs(v);
  const input: CompileInput = {
    harness: h,
    layout: layoutOf(h, v),
    policies: refs,
    task: str(v, "task"),
    repo: repoDir === null ? null : readRepo(repoDir),
    judge,
    judgeHosts: list(v, "judge-host"),
    extraReadWrite: list(v, "read-write"),
  };
  return { ok: true, input, problems };
}

/** The `openshell` binary: `--openshell` (absolute), else found on the absolute PATH entries. */
export function openShellBinary(
  v: Values,
  pathEnv: string = process.env.PATH ?? "",
): string | null {
  const given = str(v, "openshell");
  if (given !== null) return given;
  const path = pathEnv
    .split(":")
    .filter((d) => d.startsWith("/"))
    .join(":");
  return Bun.which("openshell", { PATH: path });
}

/** Compiles from parsed values, printing the report and any policy-loading problems. */
export async function compileFor(
  values: Values,
  io: Io,
  command: string,
): Promise<CompiledPolicy | number> {
  const made = await compileInputOf(values);
  if (!made.ok) {
    io.err(`cops openshell ${command}: ${made.error}`);
    return EXIT.usage;
  }
  for (const p of made.problems) io.err(`cops openshell ${command}: policy loading: ${p}`);
  const compiled = compilePolicy(made.input);
  io.err(renderReport(compiled).trimEnd());
  return compiled;
}
