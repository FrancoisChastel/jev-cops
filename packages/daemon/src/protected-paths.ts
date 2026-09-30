import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  /**
   * The installed jev-cops code when the daemon runs from an npm or bun install, the
   * source-package counterpart of `selfBinary` (see {@link installedCodeDirs}); absent or
   * empty in a source checkout or a compiled binary.
   */
  readonly installedCode?: readonly string[];
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

/**
 * The directories holding the jev-cops code when `moduleDir` (this module's directory)
 * lies in a `node_modules` tree, i.e. an npm or bun install: `node_modules/@jev-cops/`
 * (core, the daemon, the hook's adapter, the CLI, the starter policies) and
 * `node_modules/jev-cops/` (the `cops`, `copsd` and `cops-hook` bins). The hook imports
 * that code on every call and the daemon at its next start, so an agent's write there is
 * tampering with the judge. Empty outside `node_modules` (a source checkout, where the
 * code is the developer's to edit, or a compiled binary).
 */
export function installedCodeDirs(moduleDir: string = import.meta.dir): string[] {
  const parts = moduleDir.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at <= 0) return [];
  const modules = parts.slice(0, at + 1).join(sep);
  return [join(modules, "@jev-cops"), join(modules, "jev-cops")];
}

/**
 * The inputs of this process: the default user config file, `process.execPath` when
 * compiled, the installed jev-cops packages when installed from npm.
 */
export function defaultJudgeInputs(): JudgeInputs {
  const osHome = homedir();
  return {
    configFiles: [join(osHome, ".config", "jev-cops", "cops.toml")],
    selfBinary: compiledBinary(),
    installedCode: installedCodeDirs(),
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

/**
 * Every path the judge depends on: the policies directory (whole), the audit log, the
 * store, both sockets and each config file with their directories (just the file when
 * the directory is shared), the audit's file forward, `~/.jev-cops/` under the OS home and
 * `[daemon] home`, the running daemon binary when compiled (the installed jev-cops
 * packages when not) and `[daemon] hook_binary`.
 * Each entry is also listed under its real path when a symlink leads to it. Absolute,
 * deduplicated, in a stable order.
 */
export function judgeInputPaths(config: DaemonConfig, inputs: JudgeInputs): string[] {
  const shared = sharedDirs(config, inputs);
  const forward = config.audit.forward?.kind === "file" ? [config.audit.forward.target] : [];
  const binaries = [inputs.selfBinary, config.daemon.hookBinary].filter((b) => b !== null);
  const paths = [
    config.policies.dir,
    ...fileAndDir(config.audit.path, shared, []),
    ...forward,
    ...fileAndDir(config.store.path, shared, SQLITE_SIDE_FILES),
    ...fileAndDir(config.daemon.socket, shared, []),
    ...fileAndDir(config.daemon.adminSocket, shared, []),
    ...inputs.configFiles.flatMap((f) => fileAndDir(f, shared, [])),
    join(inputs.osHome, ".jev-cops"),
    join(config.daemon.home, ".jev-cops"),
    ...binaries,
    ...(inputs.installedCode ?? []),
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
 * the audit log and its forward copy, the store (SQLite side files included) with their
 * directories unless shared, `~/.jev-cops/` under the OS home and `[daemon] home` with the
 * adapters' records in it. Exempt (`!`), because agents read them legitimately or they
 * hold no record: both sockets, the policies directory and the config files. Each also
 * under its real path. Their scored decisions are the oracle agent channels never carry
 * (T6, D-066, D-096); `config-tamper` holds a read of any of them.
 */
export function judgePrivatePaths(config: DaemonConfig, inputs: JudgeInputs): string[] {
  const shared = sharedDirs(config, inputs);
  const forward = config.audit.forward?.kind === "file" ? [config.audit.forward.target] : [];
  const homes = [inputs.osHome, config.daemon.home].map((h) => join(h, ".jev-cops"));
  const records = [
    ...fileAndDir(config.audit.path, shared, []),
    ...forward,
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
