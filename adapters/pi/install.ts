import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** File name of the installed extension (Pi loads every direct `.ts` file in the directory). */
export const INSTALLED_FILE = "jev-cops.ts";
/** `sun_path` holds 104 bytes on macOS (108 on Linux) including the NUL (daemon rule). */
const MAX_SOCKET_PATH_BYTES = 103;
const SOCKET_LINE = "const INSTALLED_SOCKET: string | null = null;";

/**
 * Bypasses and limits of the Pi adapter that jev-cops cannot close from the extension.
 * Printed by the installer and, from M1, by `cops doctor` (spec: never silent).
 */
export const PI_GAPS: readonly string[] = [
  "No OpenShell: the agent runs with your permissions and can edit or delete this extension file; every deny is best-effort until the extensions directory is read-only (T1, T4).",
  "`pi --no-extensions` (-ne) starts Pi without discovered extensions, so without jev-cops; only an explicit `-e` path still loads.",
  "Project installs load only after the project is trusted in Pi; install globally for every project.",
  "A tool call blocked in `tool_call` produces no `tool_result`, so the daemon gets no post event for denied calls.",
  "`kill` blocks the call, sets Pi's batch-level `terminate` hint and calls ctx.abort() and ctx.shutdown(); shutdown is a no-op in print/json mode, so the abort is what ends a headless run.",
  "The adapter sends no `env.git`; copsd derives repo, branch, default branch (origin/HEAD) and dirty from the call's cwd with hardened read-only git. Those values come from a repository the agent can write, so it can steer them (for example point origin/HEAD elsewhere so `main` stops counting as the default branch); values it cannot derive are treated as exposure (D-024).",
  "Read-only tools (read, grep, find, ls) fail open when copsd is unreachable and are logged only to the Pi notification or stderr; every other tool fails closed.",
  "Tools from other extensions are sent as kind `other` with their raw input; nested agents started by other extensions are not linked as subagent sessions.",
  "Commands the user types with `!` in the Pi TUI (`user_bash`) do not go through `tool_call` and are not judged.",
  "Without OpenShell the agent can reach the daemon's sockets as you: the hold token keeps it from approving a hold this extension received or reading its confirm view, but it can post judge requests of its own and resolve or view those; the admin socket (budget reset, full explain) is human-only only when it is not mounted into the sandbox.",
  "Without OpenShell the agent runs as you and can read the judge's own records: ~/.jev-cops/audit.jsonl and the SQLite store hold every decision with its scores (the oracle no agent channel carries). config-tamper holds a direct read of them (cat, grep, sqlite3, the read tool, an agent-run `cops explain`); a read it cannot see (from inside an interpreter, a recursive read of a directory above them) gets through. OpenShell makes them unreadable to the agent (M2).",
  "Stopping copsd by name (`pkill`, `killall`, `kill $(pgrep …)`, a launchctl or systemctl stop) is held; a `kill <pid>`, or copsd run under another name, is not recognized. Either way the extension then blocks every non-read tool (fail closed): a denial of service, not a bypass; only OpenShell keeps the agent from signalling copsd (M2).",
  "config-tamper sees the paths a command names: a write through a variable (`d=~/.pi; … > $d/agent/settings.json`), through a symlink made earlier, or into a directory an archive or a patch fills (`tar -x`, `unzip`, `git apply`: the directory is judged, not the files in it) is caught only when a config path is named; OpenShell's read-only mounts close it (M2).",
];

/** Where and how to install the Pi extension. */
export interface InstallOptions {
  /** Install into Pi's agent directory (all projects) instead of `<projectDir>/.pi/extensions`. */
  global?: boolean;
  /** Project root for a project install; default the current directory. */
  projectDir?: string;
  /** Socket path baked into the installed file; omitted → `$JEV_COPS_SOCKET` or the default at run time. */
  socket?: string;
  /** Environment read for `PI_CODING_AGENT_DIR`; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Home directory for the default agent dir; default `os.homedir()`. */
  home?: string;
  /** Where the summary and gaps are printed; default stdout. */
  print?: (line: string) => void;
  /** Report where the extension would go and write nothing (`cops install pi --dry-run`). */
  dryRun?: boolean;
}

/** What was installed (or would be, on a dry run), with which socket, and the printed gaps. */
export interface InstallResult {
  readonly path: string;
  readonly socket: string | null;
  readonly gaps: readonly string[];
  readonly written: boolean;
}

function assertSocket(socket: string): void {
  if (!isAbsolute(socket)) throw new Error(`socket path must be absolute: ${socket}`);
  if (/[\0\r\n]/.test(socket)) throw new Error("socket path must not contain NUL or newlines");
  const bytes = Buffer.byteLength(socket);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`socket path is ${bytes} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}`);
  }
}

const MARKER = "const INSTALLED_SOCKET: string | null =";

function targetDir(opts: InstallOptions): string {
  if (opts.global !== true) return join(opts.projectDir ?? process.cwd(), ".pi", "extensions");
  const env = opts.env ?? process.env;
  const agentDir = env.PI_CODING_AGENT_DIR || join(opts.home ?? homedir(), ".pi", "agent");
  return join(agentDir, "extensions");
}

/**
 * Where the extension source can be: next to this module (source checkout), or, for the
 * compiled `dist/cops`, in the repository the binary was built in (`dist/../adapters/pi`).
 * It is not embedded: Bun keys its module cache by path, so a text import of `jev-cops.ts`
 * collides with the module import of the same file.
 */
export function extensionCandidates(execPath: string = process.execPath): string[] {
  return [
    fileURLToPath(new URL("./jev-cops.ts", import.meta.url)),
    join(dirname(execPath), "..", "adapters", "pi", "jev-cops.ts"),
  ];
}

function readExtension(candidates: readonly string[]): string {
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // not there: try the next place
    }
  }
  throw new Error(
    `the Pi extension source was not found (${candidates.join(", ")}); run cops from the jev-cops checkout`,
  );
}

/** The extension source with `socket` baked in (or unchanged when there is none). */
export function extensionSource(
  socket: string | null,
  candidates: readonly string[] = extensionCandidates(),
): string {
  const source = readExtension(candidates);
  if (!source.includes(SOCKET_LINE)) throw new Error("jev-cops.ts has no INSTALLED_SOCKET line");
  if (socket === null) return source;
  // A replacer function: a replacement *string* would expand `$&`/`$1` inside the path.
  const baked = `const INSTALLED_SOCKET: string | null = ${JSON.stringify(socket)};`;
  return source.replace(SOCKET_LINE, () => baked);
}

/** Where {@link installPiExtension} puts the extension for these options. */
export function piExtensionPath(opts: InstallOptions = {}): string {
  return join(targetDir(opts), INSTALLED_FILE);
}

function printerOf(opts: InstallOptions): (line: string) => void {
  return opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
}

/**
 * Copies the jev-cops extension into Pi's user or project extensions directory
 * (overwriting any previous copy), optionally with the daemon socket baked in, and prints
 * where it went plus {@link PI_GAPS}. With `dryRun` it only prints. Throws on an invalid
 * socket path. Used by the CLI's `cops install pi`.
 */
export function installPiExtension(opts: InstallOptions = {}): InstallResult {
  const socket = opts.socket ?? null;
  if (socket !== null) assertSocket(socket);
  const path = piExtensionPath(opts);
  const print = printerOf(opts);
  if (opts.dryRun === true) {
    print(`jev-cops: dry run, nothing written; the Pi extension would be installed at ${path}`);
  } else {
    mkdirSync(targetDir(opts), { recursive: true });
    writeFileSync(path, extensionSource(socket));
    chmodSync(path, 0o644);
    print(`jev-cops: Pi extension installed at ${path}`);
  }
  print(`jev-cops: socket ${socket ?? "$JEV_COPS_SOCKET or ~/.jev-cops/copsd.sock (at run time)"}`);
  print("jev-cops: known gaps (see docs/adapters.md#pi):");
  for (const gap of PI_GAPS) print(`  - ${gap}`);
  return { path, socket, gaps: PI_GAPS, written: opts.dryRun !== true };
}

/** What an uninstall found and did. */
export interface UninstallResult {
  readonly path: string;
  /** The jev-cops extension was there. */
  readonly present: boolean;
  readonly removed: boolean;
}

/**
 * Removes the installed jev-cops extension (`cops install pi --uninstall`); with `dryRun`,
 * only reports. Throws when the file there is not the jev-cops extension (never deletes
 * someone else's file).
 */
export function uninstallPiExtension(opts: InstallOptions = {}): UninstallResult {
  const path = piExtensionPath(opts);
  const print = printerOf(opts);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    print(`jev-cops: no Pi extension at ${path}`);
    return { path, present: false, removed: false };
  }
  if (!text.includes(MARKER)) throw new Error(`${path} is not the jev-cops extension; left alone`);
  if (opts.dryRun === true) {
    print(`jev-cops: dry run, nothing removed; would remove ${path}`);
    return { path, present: true, removed: false };
  }
  unlinkSync(path);
  print(`jev-cops: Pi extension removed from ${path}`);
  return { path, present: true, removed: true };
}
