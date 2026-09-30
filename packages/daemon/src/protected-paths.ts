import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { DaemonConfig } from "./config.ts";

/**
 * The judge protects its own inputs (PLAN-M1 §4.5, "jev-cops" row): `config-tamper` only
 * knows the paths the daemon hands it in `[policy] protectedPaths`, so the daemon appends
 * everything it reads or writes to that list whenever it builds a runtime from config.
 */

/** What the daemon knows about itself beyond its resolved config. */
export interface JudgeInputs {
  /** Config files its settings come from (`LoadedConfig.inputs`), absolute. */
  readonly configFiles: readonly string[];
  /** The running daemon binary when compiled; null under `bun run`/`bun test`. */
  readonly selfBinary: string | null;
  /** The OS user's home: the defaults live in its `~/.jev-cops/`, whatever `[daemon] home` says. */
  readonly osHome: string;
  /** The daemon's working directory; it and every directory above it are shared. */
  readonly cwd: string;
}

/** Where a `bun build --compile` binary sees its own entry point (POSIX, Windows). */
const COMPILED_ROOTS = ["/$bunfs/", "B:/~BUN/"];
/** Files SQLite keeps next to a database. */
const SQLITE_SIDE_FILES = ["-wal", "-shm", "-journal"];
/** System temp directories: shared by every process, never protected whole. */
const SHARED_TMP = ["/tmp", "/var/tmp"];

/** `execPath` when `main` is the entry point of a compiled binary, else null. */
export function compiledBinary(
  main: string = Bun.main,
  execPath: string = process.execPath,
): string | null {
  return COMPILED_ROOTS.some((root) => main.startsWith(root)) ? execPath : null;
}

/** The inputs of this process: the default user config file, `process.execPath` when compiled. */
export function defaultJudgeInputs(): JudgeInputs {
  const osHome = homedir();
  return {
    configFiles: [join(osHome, ".config", "jev-cops", "cops.toml")],
    selfBinary: compiledBinary(),
    osHome,
    cwd: process.cwd(),
  };
}

/**
 * `path` with symlinks resolved as far as it exists: the deepest existing ancestor goes
 * through `realpath`, the rest is appended (a socket or log not created yet).
 */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

function ancestorsOf(path: string): string[] {
  const parent = dirname(path);
  return parent === path ? [path] : [path, ...ancestorsOf(parent)];
}

/**
 * Directories other processes write to all the time: the filesystem root, the homes, the
 * daemon's cwd and every directory above them, the system temp directories. A file of the
 * judge's that sits in one is protected alone, never the whole directory (killing every
 * write to `/tmp` or `~` would end ordinary sessions).
 */
function sharedDirs(config: DaemonConfig, inputs: JudgeInputs): Set<string> {
  const roots = [inputs.osHome, config.daemon.home, inputs.cwd, tmpdir(), ...SHARED_TMP];
  const all = roots
    .map((r) => resolve(r))
    .flatMap((r) => [...ancestorsOf(r), ...ancestorsOf(realPath(r))]);
  return new Set(all);
}

/** A file the judge reads or writes, and the directory it lives in unless that is shared. */
function fileAndDir(file: string, shared: ReadonlySet<string>, sideFiles: readonly string[]) {
  const dir = dirname(file);
  const isShared = shared.has(dir) || shared.has(realPath(dir));
  return isShared ? [file, ...sideFiles.map((s) => `${file}${s}`)] : [file, dir];
}

/** A file and the files the daemon writes next to it (temp, pending). */
const CURSOR_SIDE_FILES = [".tmp"];
const KEY_SIDE_FILES = [".next"];

/**
 * The audit's own files (D-103, D-104): the forward cursor, the signing key (and the key a
 * rotation is waiting to switch to), each with its directory unless shared, and the files
 * given alone: the file forward's copy, the public key, the syslog CA and client key.
 */
function auditFiles(config: DaemonConfig, shared: ReadonlySet<string>) {
  const fwd = config.audit.forward;
  const copy = fwd?.kind === "file" ? [fwd.target] : [];
  const cursor = fwd === null ? [] : fileAndDir(fwd.cursor, shared, CURSOR_SIDE_FILES);
  const tls = [fwd?.syslog?.ca, fwd?.syslog?.cert, fwd?.syslog?.key].filter(
    (p): p is string => typeof p === "string",
  );
  const clientKey = fwd?.syslog?.key ?? null;
  const key = fileAndDir(config.audit.key, shared, KEY_SIDE_FILES);
  return { copy, cursor, tls, clientKey: clientKey === null ? [] : [clientKey], key };
}

/**
 * Every path the judge depends on: the policies directory (whole), the audit log, the
 * store, both sockets and each config file with their directories (just the file when
 * the directory is shared), the audit's forward copy, cursor, signing and public keys and
 * TLS files, `~/.jev-cops/` under the OS home and `[daemon] home`, the running daemon
 * binary when compiled and `[daemon] hook_binary`. Each entry is also listed under its
 * real path when a symlink leads to it. Absolute, deduplicated, in a stable order.
 */
export function judgeInputPaths(config: DaemonConfig, inputs: JudgeInputs): string[] {
  const shared = sharedDirs(config, inputs);
  const audit = auditFiles(config, shared);
  const binaries = [inputs.selfBinary, config.daemon.hookBinary].filter((b) => b !== null);
  const paths = [
    config.policies.dir,
    ...fileAndDir(config.audit.path, shared, []),
    ...audit.copy,
    ...audit.cursor,
    ...audit.key,
    config.audit.publicKey,
    ...audit.tls,
    ...fileAndDir(config.store.path, shared, SQLITE_SIDE_FILES),
    ...fileAndDir(config.daemon.socket, shared, []),
    ...fileAndDir(config.daemon.adminSocket, shared, []),
    ...inputs.configFiles.flatMap((f) => fileAndDir(f, shared, [])),
    join(inputs.osHome, ".jev-cops"),
    join(config.daemon.home, ".jev-cops"),
    ...binaries,
  ];
  return [...new Set(paths.flatMap((p) => [p, realPath(p)]))];
}

/**
 * Records the Claude Code adapter keeps in `~/.jev-cops/` (its hook log and install state),
 * named so they stay private even if an exemption covered the directory.
 */
const ADAPTER_RECORDS = ["claude-code-hook.log", "claude-code.json"];

/**
 * The judge's own records, as `[policy] privatePaths` entries (M1 gate review, finding M2):
 * the audit log and its forward copy and cursor, the signing key (D-098: never readable by
 * the agent) and a syslog client key, the store (SQLite side files included) with their
 * directories unless shared, `~/.jev-cops/` under the OS home and `[daemon] home` with the
 * adapters' records in it. Exempt (`!`), because agents read them legitimately or they
 * hold no record: both sockets, the policies directory and the config files. Each also
 * under its real path. Their scored decisions are the oracle agent channels never carry
 * (T6, D-066, D-096); `config-tamper` holds a read of any of them.
 */
export function judgePrivatePaths(config: DaemonConfig, inputs: JudgeInputs): string[] {
  const shared = sharedDirs(config, inputs);
  const audit = auditFiles(config, shared);
  const homes = [inputs.osHome, config.daemon.home].map((h) => join(h, ".jev-cops"));
  const records = [
    ...fileAndDir(config.audit.path, shared, []),
    ...audit.copy,
    ...audit.cursor,
    ...audit.key,
    ...audit.clientKey,
    ...fileAndDir(config.store.path, shared, SQLITE_SIDE_FILES),
    ...homes.flatMap((dir) => [dir, ...ADAPTER_RECORDS.map((f) => join(dir, f))]),
  ];
  const open = [config.daemon.socket, config.daemon.adminSocket, config.policies.dir];
  const exempt = [...open, ...inputs.configFiles].map((p) => `!${p}`);
  const withReal = (p: string) =>
    p.startsWith("!") ? [p, `!${realPath(p.slice(1))}`] : [p, realPath(p)];
  return [...new Set([...records, ...exempt].flatMap(withReal))];
}

/** How many paths `config`'s `[policy] protectedPaths` holds (`/v1/health`, the boot line). */
export function protectedPathCount(config: DaemonConfig): number {
  return config.policy.protectedPaths?.length ?? 0;
}

/**
 * `config` with {@link judgeInputPaths} appended to `[policy] protectedPaths` and
 * {@link judgePrivatePaths} to `[policy] privatePaths`: the configured entries stay first
 * and are never dropped, so neither the user config nor a repo override (which may not
 * change either list at all) can remove the judge's own paths. Returns a new config;
 * `config` is untouched.
 */
export function protectJudgeInputs(config: DaemonConfig, inputs: JudgeInputs): DaemonConfig {
  const append = (configured: readonly string[] | undefined, own: readonly string[]) => [
    ...new Set([...(configured ?? []), ...own]),
  ];
  const protectedPaths = append(config.policy.protectedPaths, judgeInputPaths(config, inputs));
  const privatePaths = append(config.policy.privatePaths, judgePrivatePaths(config, inputs));
  return { ...config, policy: { ...config.policy, protectedPaths, privatePaths } };
}
