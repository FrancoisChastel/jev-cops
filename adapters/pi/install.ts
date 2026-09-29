import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** File name of the installed extension (Pi loads every direct `.ts` file in the directory). */
export const INSTALLED_FILE = "jevdict.ts";
/** `sun_path` holds 104 bytes on macOS (108 on Linux) including the NUL (daemon rule). */
const MAX_SOCKET_PATH_BYTES = 103;
const SOCKET_LINE = "const INSTALLED_SOCKET: string | null = null;";

/**
 * Bypasses and limits of the Pi adapter that jevdict cannot close from the extension.
 * Printed by the installer and, from M1, by `jevdict doctor` (spec: never silent).
 */
export const PI_GAPS: readonly string[] = [
  "No OpenShell: the agent runs with your permissions and can edit or delete this extension file; every deny is best-effort until the extensions directory is read-only (T1, T4).",
  "`pi --no-extensions` (-ne) starts Pi without discovered extensions, so without jevdict; only an explicit `-e` path still loads.",
  "Project installs load only after the project is trusted in Pi; install globally for every project.",
  "A tool call blocked in `tool_call` produces no `tool_result`, so the daemon gets no post event for denied calls.",
  "`kill` blocks the call, sets Pi's batch-level `terminate` hint and calls ctx.abort() and ctx.shutdown(); shutdown is a no-op in print/json mode, so the abort is what ends a headless run.",
  "The adapter sends no `env.git`; jevdictd derives repo, branch, default branch (origin/HEAD) and dirty from the call's cwd with hardened read-only git. Those values come from a repository the agent can write, so it can steer them (for example point origin/HEAD elsewhere so `main` stops counting as the default branch); values it cannot derive are treated as exposure (D-024).",
  "Read-only tools (read, grep, find, ls) fail open when jevdictd is unreachable and are logged only to the Pi notification or stderr; every other tool fails closed.",
  "Tools from other extensions are sent as kind `other` with their raw input; nested agents started by other extensions are not linked as subagent sessions.",
  "Commands the user types with `!` in the Pi TUI (`user_bash`) do not go through `tool_call` and are not judged.",
  "Without OpenShell the agent can reach the daemon's sockets as you: the hold token keeps it from approving a hold this extension received or reading its confirm view, but it can post judge requests of its own and resolve or view those; the admin socket (budget reset, full explain) is human-only only when it is not mounted into the sandbox.",
];

/** Where and how to install the Pi extension. */
export interface InstallOptions {
  /** Install into Pi's agent directory (all projects) instead of `<projectDir>/.pi/extensions`. */
  global?: boolean;
  /** Project root for a project install; default the current directory. */
  projectDir?: string;
  /** Socket path baked into the installed file; omitted → `$JEVDICT_SOCKET` or the default at run time. */
  socket?: string;
  /** Environment read for `PI_CODING_AGENT_DIR`; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Home directory for the default agent dir; default `os.homedir()`. */
  home?: string;
  /** Where the summary and gaps are printed; default stdout. */
  print?: (line: string) => void;
}

/** What was installed, with which socket, and the gaps that were printed. */
export interface InstallResult {
  readonly path: string;
  readonly socket: string | null;
  readonly gaps: readonly string[];
}

function assertSocket(socket: string): void {
  if (!isAbsolute(socket)) throw new Error(`socket path must be absolute: ${socket}`);
  if (/[\0\r\n]/.test(socket)) throw new Error("socket path must not contain NUL or newlines");
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`socket path is ${bytes} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}`);
  }
}

function targetDir(opts: InstallOptions): string {
  if (opts.global !== true) return join(opts.projectDir ?? process.cwd(), ".pi", "extensions");
  const env = opts.env ?? process.env;
  const agentDir = env.PI_CODING_AGENT_DIR || join(opts.home ?? homedir(), ".pi", "agent");
  return join(agentDir, "extensions");
}

/** The extension source with `socket` baked in (or unchanged when there is none). */
export function extensionSource(socket: string | null): string {
  const source = readFileSync(new URL("./jevdict.ts", import.meta.url), "utf8");
  if (!source.includes(SOCKET_LINE)) throw new Error("jevdict.ts has no INSTALLED_SOCKET line");
  if (socket === null) return source;
  // A replacer function: a replacement *string* would expand `$&`/`$1` inside the path.
  const baked = `const INSTALLED_SOCKET: string | null = ${JSON.stringify(socket)};`;
  return source.replace(SOCKET_LINE, () => baked);
}

/**
 * Copies the jevdict extension into Pi's user or project extensions directory
 * (overwriting any previous copy), optionally with the daemon socket baked in, and prints
 * where it went plus {@link PI_GAPS}. Throws on an invalid socket path. Used by the CLI's
 * `jevdict install pi` (M1).
 */
export function installPiExtension(opts: InstallOptions = {}): InstallResult {
  const socket = opts.socket ?? null;
  if (socket !== null) assertSocket(socket);
  const dir = targetDir(opts);
  const path = join(dir, INSTALLED_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, extensionSource(socket));
  chmodSync(path, 0o644);
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  print(`jevdict: Pi extension installed at ${path}`);
  print(`jevdict: socket ${socket ?? "$JEVDICT_SOCKET or ~/.jevdict/jevdictd.sock (at run time)"}`);
  print("jevdict: known gaps (see docs/adapters.md#pi):");
  for (const gap of PI_GAPS) print(`  - ${gap}`);
  return { path, socket, gaps: PI_GAPS };
}
