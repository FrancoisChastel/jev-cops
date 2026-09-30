/**
 * `cops install <harness> [options]` argument parsing: strict (an unknown option is a
 * usage error, exit 2), one scope per run.
 */

import { parseArgs } from "node:util";
import type { InstallScope, Transport } from "@jev-cops/adapter-claude-code";

/** Options both harnesses take. */
export interface CommonInstallArgs {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly uninstall: boolean;
  /** `--home`: the home directory to install under instead of the real one. */
  readonly home: string | null;
  readonly projectDir: string | null;
  readonly socket: string | null;
}

/** `cops install claude-code …`. */
export interface ClaudeInstallArgs extends CommonInstallArgs {
  readonly harness: "claude-code";
  readonly scope: InstallScope;
  readonly transport: Transport;
  readonly hookBinary: string | null;
  /** `--config`: the cops.toml to record `[daemon] hook_binary` in (and to read). */
  readonly config: string | null;
  readonly force: boolean;
}

/** `cops install pi …`. */
export interface PiInstallArgs extends CommonInstallArgs {
  readonly harness: "pi";
  /** Pi's agent directory (all projects) rather than `<project>/.pi/extensions`. */
  readonly global: boolean;
}

/** Parsed arguments, or a usage error. */
export type ParsedInstallArgs =
  | { readonly ok: true; readonly args: ClaudeInstallArgs | PiInstallArgs }
  | { readonly ok: false; readonly error: string };

const COMMON = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  uninstall: { type: "boolean" },
  home: { type: "string" },
  "project-dir": { type: "string" },
  socket: { type: "string" },
  project: { type: "boolean" },
} as const;

const CLAUDE = {
  ...COMMON,
  user: { type: "boolean" },
  local: { type: "boolean" },
  managed: { type: "boolean" },
  transport: { type: "string" },
  "hook-binary": { type: "string" },
  config: { type: "string" },
  force: { type: "boolean" },
} as const;

const PI = { ...COMMON, global: { type: "boolean" } } as const;

type Values = Record<string, string | boolean | undefined>;

function common(v: Values): CommonInstallArgs {
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  return {
    json: v.json === true,
    dryRun: v["dry-run"] === true,
    uninstall: v.uninstall === true,
    home: str("home"),
    projectDir: str("project-dir"),
    socket: str("socket"),
  };
}

function claude(v: Values): ParsedInstallArgs {
  const scopes = (["user", "project", "local", "managed"] as const).filter((s) => v[s] === true);
  if (scopes.length > 1)
    return { ok: false, error: `choose one scope, not ${scopes.join(" and ")}` };
  const transport = v.transport ?? "command";
  if (transport !== "command" && transport !== "http") {
    return { ok: false, error: `--transport must be command or http, got ${String(transport)}` };
  }
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : null);
  const args: ClaudeInstallArgs = {
    ...common(v),
    harness: "claude-code",
    scope: scopes[0] ?? "user",
    transport,
    hookBinary: str("hook-binary"),
    config: str("config"),
    force: v.force === true,
  };
  return { ok: true, args };
}

function pi(v: Values): ParsedInstallArgs {
  if (v.global === true && v.project === true) {
    return { ok: false, error: "choose --global or --project, not both" };
  }
  return { ok: true, args: { ...common(v), harness: "pi", global: v.project !== true } };
}

/** Parses `argv` after `install`: the harness, then its options. */
export function parseInstallArgs(argv: readonly string[]): ParsedInstallArgs {
  const [harness, ...rest] = argv;
  if (harness !== "claude-code" && harness !== "pi") {
    return {
      ok: false,
      error: `install needs a harness: claude-code or pi (got ${harness ?? "none"})`,
    };
  }
  try {
    const options = harness === "pi" ? PI : CLAUDE;
    const { values } = parseArgs({
      args: [...rest],
      options,
      strict: true,
      allowPositionals: false,
    });
    return harness === "pi" ? pi(values as Values) : claude(values as Values);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
