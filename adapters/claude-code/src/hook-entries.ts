/**
 * The hook entries `cops install claude-code` registers (PLAN-M1 §4.3, D-075 proposal) and
 * which handlers in a settings file are the installer's own. Exec form (`command` + `args`,
 * no shell), no matcher (every tool), one group per event. Timeouts sit above the hook's
 * own deadlines (intact.ts `MIN_TIMEOUT_S`) so Claude Code's timeout, which lets the call
 * proceed, never fires first (hooks#timeouts).
 */
import { basename, isAbsolute } from "node:path";
import { namedProgram, realpathOrNull } from "./hook-identity.ts";

/** Every event the installer registers, in the order it writes them. */
export const INSTALLED_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "ConfigChange",
  "SessionStart",
  "SessionEnd",
] as const;

/** One of {@link INSTALLED_EVENTS}. */
export type InstalledEvent = (typeof INSTALLED_EVENTS)[number];

/** Settings `timeout` (seconds) per event: 30 for the gate, 15 for posts, 10 for the rest. */
export const HOOK_TIMEOUTS_S: Readonly<Record<InstalledEvent, number>> = Object.freeze({
  PreToolUse: 30,
  PostToolUse: 15,
  PostToolUseFailure: 15,
  UserPromptSubmit: 10,
  ConfigChange: 10,
  SessionStart: 10,
  SessionEnd: 10,
});

/** The daemon route HTTP post hooks target (D-080). */
export const CLAUDE_CODE_HOOK_PATH = "/v1/hooks/claude-code";

/** How post events reach the daemon: the command hook, or HTTP (post events only, D-066 proposal). */
export type Transport = "command" | "http";

/** A command hook in exec form. */
export interface CommandHandler {
  readonly type: "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

/** An HTTP hook (post events with `--transport http`). */
export interface HttpHandler {
  readonly type: "http";
  readonly url: string;
  readonly timeout: number;
}

/** One matcher group; no `matcher` key means every tool. */
export interface HookGroup {
  readonly hooks: readonly (CommandHandler | HttpHandler)[];
}

/** The groups to register, per event. */
export type HookEntries = Readonly<Record<InstalledEvent, readonly HookGroup[]>>;

/** `http://<loopback>:<port>`, no path: the only daemon URL a hook may name (T13). */
const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;
const MAX_PORT = 65_535;

/** True for `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`. */
export function isLoopbackHttpUrl(url: string): boolean {
  const port = Number(LOOPBACK_URL.exec(url)?.[1] ?? Number.NaN);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT;
}

const POST_EVENTS: ReadonlySet<InstalledEvent> = new Set(["PostToolUse", "PostToolUseFailure"]);

function checkInputs(hookBinary: string, socket: string, transport: Transport, url?: string) {
  if (!isAbsolute(hookBinary)) throw new Error(`hook binary must be absolute: ${hookBinary}`);
  if (!isAbsolute(socket)) throw new Error(`socket must be absolute: ${socket}`);
  if (transport === "http" && (url === undefined || !isLoopbackHttpUrl(url))) {
    throw new Error(`--transport http needs the daemon's loopback URL, got ${url ?? "none"}`);
  }
}

/**
 * The entries for every {@link INSTALLED_EVENTS} event. With `http`, `PostToolUse` and
 * `PostToolUseFailure` are HTTP hooks to `httpUrl` + {@link CLAUDE_CODE_HOOK_PATH}, and every
 * command entry carries `--http-url` so the ConfigChange check can recognise them (intact.ts).
 * Throws on a relative binary or socket, or an HTTP transport without a loopback URL.
 */
export function jevCopsHookEntries(
  hookBinary: string,
  socket: string,
  transport: Transport = "command",
  httpUrl?: string,
): HookEntries {
  checkInputs(hookBinary, socket, transport, httpUrl);
  const http = transport === "http" ? (httpUrl ?? "") : null;
  const args = ["--harness", "claude-code", "--socket", socket];
  const commandArgs = http === null ? args : [...args, "--http-url", http];
  const group = (event: InstalledEvent): HookGroup => {
    const timeout = HOOK_TIMEOUTS_S[event];
    if (http !== null && POST_EVENTS.has(event)) {
      return { hooks: [{ type: "http", url: `${http}${CLAUDE_CODE_HOOK_PATH}`, timeout }] };
    }
    return { hooks: [{ type: "command", command: hookBinary, args: commandArgs, timeout }] };
  };
  return Object.freeze(
    Object.fromEntries(INSTALLED_EVENTS.map((e) => [e, [group(e)]])) as Record<
      InstalledEvent,
      HookGroup[]
    >,
  );
}

/**
 * Program names the installer has ever registered, or the README shows: the compiled hook,
 * the npm meta package's `bin/cops-hook.ts` (the Docker e2e's F2: uninstall missed it), the
 * adapter's `hook-main.ts`, and the CLI (`cops hook`), compiled or as the meta package's
 * `bin/cops.ts`. Matched on the program an entry names (hook-identity.ts `namedProgram`: the
 * script under `bun`, else the command).
 */
const HOOK_NAMES: ReadonlySet<string> = new Set([
  "cops-hook",
  "cops-hook.exe",
  "cops-hook.ts",
  "hook-main.ts",
  "cops",
  "cops.exe",
  "cops.ts",
  "jev-cops",
]);
const SHELL_FORM = /(?:^|[/\s])cops(?:-hook)?(?:\.exe)?\s(?:.*\s)?--harness[= ]claude-code\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forClaudeCode(args: readonly string[]): boolean {
  return args.some(
    (a, k) => a === "--harness=claude-code" || (a === "--harness" && args[k + 1] === "claude-code"),
  );
}

/** Whether `path` is one of `known` (as written, or the same file after symlinks). */
function isKnown(path: string, known: readonly string[]): boolean {
  if (known.includes(path)) return true;
  const real = realpathOrNull(path);
  return real !== null && known.some((k) => realpathOrNull(k) === real);
}

function ownsCommand(command: string, args: unknown, known: readonly string[]): boolean {
  if (args === undefined) return SHELL_FORM.test(command);
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) return false;
  if (!forClaudeCode(args)) return false;
  const program = namedProgram(command, args);
  if (HOOK_NAMES.has(basename(command)) || HOOK_NAMES.has(basename(program))) return true;
  return isKnown(command, known) || isKnown(program, known);
}

function ownsUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).pathname === CLAUDE_CODE_HOOK_PATH;
  } catch {
    return false; // not a URL: not the daemon's route
  }
}

/** Hook binaries whose entries are jev-cops's whatever their name (one path, or several). */
export type KnownHooks = string | readonly string[];

/**
 * True when `handler` is a jev-cops Claude Code hook the installer wrote (now or by an
 * earlier version, or by hand from the README): a command hook for `--harness claude-code`
 * whose program (the command, or the script under `bun`) is named as one of
 * {@link HOOK_NAMES} or is one of the `known` hook binaries (the one being installed, the
 * one recorded in cops.toml or the state file; symlinks resolved), or an HTTP hook to the
 * daemon's {@link CLAUDE_CODE_HOOK_PATH}. Identity for merge, idempotence and uninstall;
 * the ConfigChange check (intact.ts) is the strict one.
 */
export function isJevCopsEntry(handler: unknown, known?: KnownHooks): boolean {
  if (!isRecord(handler)) return false;
  if (handler.type === "http") return ownsUrl(handler.url);
  if (handler.type !== "command" || typeof handler.command !== "string") return false;
  const binaries = known === undefined ? [] : typeof known === "string" ? [known] : known;
  return ownsCommand(handler.command, handler.args, binaries);
}
