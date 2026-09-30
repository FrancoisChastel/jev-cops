/**
 * What `cops install` resolves before touching anything: the home (`--home` or the real
 * one), the project dir, the environment narrowed to that home, and for Claude Code the
 * daemon config (socket, loopback HTTP URL, enforcement mode) read the way copsd reads it,
 * and the cops.toml that records `[daemon] hook_binary`.
 */

import { join, resolve } from "node:path";
import { type InstallOptions, managedDirFor, writeFileAtomic } from "@jev-cops/adapter-claude-code";
import { ConfigError, type HttpBind, loadConfig } from "@jev-cops/daemon";
import { setDaemonHookBinary } from "../toml-key.ts";
import type { ClaudeInstallArgs, CommonInstallArgs } from "./install-args.ts";
import { type InstallContext, scopedEnv } from "./install-context.ts";

/** Home, project and environment for one run. */
export interface BaseSetup {
  readonly home: string;
  readonly projectDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly warnings: readonly string[];
}

/** Everything a Claude Code install needs besides the hook binary. */
export interface Setup extends BaseSetup {
  readonly configDir: string | null;
  readonly managedDir: string | null;
  readonly socket: string;
  /** The daemon's loopback URL (`[daemon] http`), or null. */
  readonly httpUrl: string | null;
  readonly enforcement: "observe" | "enforce";
  /** The cops.toml `[daemon] hook_binary` is written to (`--config`, else the user file). */
  readonly configPath: string;
}

/** `sun_path` holds 104 bytes on macOS including the NUL (daemon and Pi installer rule). */
const MAX_SOCKET_BYTES = 103;

/** Home, project dir and the environment narrowed to an explicit `--home`. */
export function resolveBase(a: CommonInstallArgs, ctx: InstallContext): BaseSetup {
  const explicit = a.home !== null;
  const home = explicit ? resolve(ctx.cwd, a.home ?? "") : ctx.home;
  const { env, dropped } = scopedEnv(ctx.env, home, explicit);
  const warnings = dropped.map((k) => `ignored $${k}: it points outside --home ${home}`);
  return { home, projectDir: resolve(ctx.cwd, a.projectDir ?? "."), env, warnings };
}

/** Why `socket` cannot be a Unix socket path, or null. */
export function socketProblem(socket: string): string | null {
  if (/[\0\r\n]/.test(socket)) return "the socket path must not contain NUL or newlines";
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_BYTES) {
    return `the socket path is ${bytes} bytes; the limit is ${MAX_SOCKET_BYTES}`;
  }
  return null;
}

/** `http://host:port` for a loopback bind; null for none or port 0 (unknown until start). */
export function httpUrlOf(bind: HttpBind | null): string | null {
  if (bind === null || bind.port === 0) return null;
  const host = bind.host.includes(":") ? `[${bind.host}]` : bind.host;
  return `http://${host}:${bind.port}`;
}

type Resolved =
  | { readonly ok: true; readonly setup: Setup }
  | { readonly ok: false; readonly error: string };

/** The Claude Code setup; a cops.toml that does not load is an error (fix it first). */
export function resolveSetup(a: ClaudeInstallArgs, ctx: InstallContext): Resolved {
  const base = resolveBase(a, ctx);
  const configPath =
    a.config === null
      ? join(base.home, ".config", "jev-cops", "cops.toml")
      : resolve(ctx.cwd, a.config);
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({
      home: base.home,
      env: base.env,
      cwd: base.projectDir,
      ...(a.config !== null && ctx.fs.exists(configPath) ? { configPath } : {}),
    });
  } catch (cause) {
    const why = cause instanceof ConfigError ? cause.message : String(cause);
    return { ok: false, error: `cannot read the jev-cops config: ${why}` };
  }
  const socket = a.socket === null ? loaded.config.daemon.socket : resolve(ctx.cwd, a.socket);
  const bad = socketProblem(socket);
  if (bad !== null) return { ok: false, error: bad };
  const managedDir = ctx.managedDir !== undefined ? ctx.managedDir : managedDirFor(ctx.platform);
  const setup: Setup = {
    ...base,
    configDir: base.env.CLAUDE_CONFIG_DIR || null,
    managedDir,
    socket,
    httpUrl: httpUrlOf(loaded.config.daemon.http),
    enforcement: loaded.config.enforcement.mode,
    configPath,
  };
  return { ok: true, setup };
}

/** The adapter's install options for these arguments. */
export function settingsOptions(
  a: ClaudeInstallArgs,
  s: Setup,
  ctx: InstallContext,
  hookBinary: string,
): InstallOptions {
  return {
    scope: a.scope,
    home: s.home,
    projectDir: s.projectDir,
    configDir: s.configDir,
    managedDir: s.managedDir,
    hookBinary,
    socket: s.socket,
    transport: a.transport,
    httpUrl: s.httpUrl,
    force: a.force,
    dryRun: a.dryRun,
    isRoot: ctx.isRoot,
    pathEnv: s.env.PATH ?? "",
    fs: ctx.fs,
    now: ctx.now,
  };
}

/**
 * Sets `[daemon] hook_binary` in the setup's cops.toml (0600; copsd then protects the
 * binary, D-082). Returns the previous text for a rollback. Throws when the file cannot be
 * edited safely (the message says what to add by hand).
 */
export function writeHookBinaryToml(s: Setup, hookBinary: string, ctx: InstallContext) {
  const previous = ctx.fs.readFile(s.configPath);
  const next = setDaemonHookBinary(previous, hookBinary);
  if (next === previous) return { path: s.configPath, previous, changed: false };
  const now = ctx.now();
  writeFileAtomic(s.configPath, next, {
    mode: 0o600,
    dirMode: 0o700,
    now,
    fs: ctx.fs,
    backup: false,
  });
  return { path: s.configPath, previous, changed: true };
}
