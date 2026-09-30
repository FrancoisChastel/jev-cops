/**
 * The hook entries `cops install claude-code` registers (PLAN-M1 §4.3, D-075 proposal) and
 * which handlers in a settings file are the installer's own. Exec form (`command` + `args`,
 * no shell), no matcher (every tool), one group per event. Timeouts sit above the hook's
 * own deadlines (intact.ts `MIN_TIMEOUT_S`) so Claude Code's timeout, which lets the call
 * proceed, never fires first (hooks#timeouts).
 */
import { basename, isAbsolute } from "node:path";

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

/** Executable names the installer has ever registered (the compiled hook, the CLI). */
const HOOK_NAMES: ReadonlySet<string> = new Set([
  "cops-hook",
  "cops-hook.exe",
  "cops",
  "cops.exe",
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

function ownsCommand(command: string, args: unknown, hookBinary?: string): boolean {
  if (args === undefined) return SHELL_FORM.test(command);
  if (!Array.isArray(args) || !args.every((a): a is string => typeof a === "string")) return false;
  if (!forClaudeCode(args)) return false;
  if (command === hookBinary || HOOK_NAMES.has(basename(command))) return true;
  return args.some((a) => basename(a) === "hook-main.ts");
}

function ownsUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).pathname === CLAUDE_CODE_HOOK_PATH;
  } catch {
    return false; // not a URL: not the daemon's route
  }
}

/**
 * True when `handler` is a jev-cops Claude Code hook the installer wrote (now or by an
 * earlier version, or by hand from the README): a command hook for `--harness claude-code`
 * run by `cops-hook`, `cops hook`, `bun …/hook-main.ts` or `hookBinary`, or an HTTP hook to
 * the daemon's {@link CLAUDE_CODE_HOOK_PATH}. Identity for merge, idempotence and uninstall;
 * the ConfigChange check (intact.ts) is the strict one.
 */
export function isJevCopsEntry(handler: unknown, hookBinary?: string): boolean {
  if (!isRecord(handler)) return false;
  if (handler.type === "http") return ownsUrl(handler.url);
  if (handler.type !== "command" || typeof handler.command !== "string") return false;
  return ownsCommand(handler.command, handler.args, hookBinary);
}
