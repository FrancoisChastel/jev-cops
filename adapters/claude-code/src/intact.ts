/**
 * "Intact" for a ConfigChange (T1, D-077): after the change, the cops hook is still in
 * force on every event it guards. Precisely: for each of {@link REQUIRED_EVENTS}, some
 * settings file Claude Code loads registers, in a group whose matcher selects every call
 * (absent, `""` or `"*"`; `UserPromptSubmit` has no matcher), a handler that is this very
 * hook: exec form, the same executable (after `${CLAUDE_PROJECT_DIR}`, PATH and symlinks),
 * the same leading arguments, `--harness claude-code`, the same socket, no `if`, not async,
 * and a timeout above the hook's own deadline; and nothing disables it (`disableAllHooks` anywhere for a
 * non-managed install, or in managed settings; `allowManagedHooksOnly` in managed settings
 * over a non-managed install). A changed file that is not valid JSON is not intact.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseHookArgs } from "./args.ts";
import type { SettingsFile, SettingsRead } from "./settings.ts";

/** The events jev-cops must stay registered on: the gate, its taint feed, its prompt and config guards. */
export const REQUIRED_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "ConfigChange",
] as const;

/** One of {@link REQUIRED_EVENTS}. */
export type RequiredEvent = (typeof REQUIRED_EVENTS)[number];

/** Smallest settings `timeout` (s) that cannot cancel the hook before its own deadline. */
export const MIN_TIMEOUT_S: Readonly<Record<RequiredEvent, number>> = {
  PreToolUse: 14,
  PostToolUse: 6,
  PostToolUseFailure: 6,
  UserPromptSubmit: 6,
  ConfigChange: 6,
};

/** This hook: how it was started, which socket it talks to, and where names resolve. */
export interface HookIdentity {
  readonly command: string;
  readonly leading: readonly string[];
  readonly socket: string;
  readonly home: string;
  readonly projectDir: string;
  /** `PATH`, to resolve a bare command name as exec form does. */
  readonly path: string;
}

/** The outcome, with the reason (logged, and sent nowhere the agent reads). */
export interface IntactCheck {
  readonly intact: boolean;
  readonly why: string;
}

type Json = Record<string, unknown>;
const MATCH_ALL: ReadonlySet<unknown> = new Set([undefined, "", "*"]);
const NO_MATCHER: ReadonlySet<string> = new Set(["UserPromptSubmit"]);

function isRecord(value: unknown): value is Json {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function realpath(path: string | null): string | null {
  try {
    return path === null ? null : realpathSync(path);
  } catch {
    return null; // missing or unreadable: never the same file as this hook
  }
}

/** The file an exec-form `command` spawns: placeholders substituted, bare names on PATH. */
function commandFile(command: string, id: HookIdentity): string | null {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's literal placeholder
  const expanded = command.replaceAll("${CLAUDE_PROJECT_DIR}", id.projectDir);
  if (expanded.includes("/")) return realpath(resolve(id.projectDir, expanded));
  return realpath(Bun.which(expanded, { PATH: id.path }));
}

function sameArg(entry: string, mine: string, id: HookIdentity): boolean {
  if (entry === mine) return true;
  const a = realpath(resolve(id.projectDir, entry));
  return a !== null && a === realpath(mine);
}

function settled(event: RequiredEvent, h: Json): boolean {
  if ("if" in h || h.async === true || h.asyncRewake === true) return false;
  return (
    h.timeout === undefined || (typeof h.timeout === "number" && h.timeout >= MIN_TIMEOUT_S[event])
  );
}

function isOurCommand(h: Json, id: HookIdentity): boolean {
  const args = h.args;
  if (h.type !== "command" || typeof h.command !== "string" || !Array.isArray(args)) return false;
  if (!args.every((a): a is string => typeof a === "string")) return false;
  const self = realpath(id.command);
  if (self === null || commandFile(h.command, id) !== self) return false;
  if (!id.leading.every((mine, k) => sameArg(args[k] ?? "", mine, id))) return false;
  const flags = parseHookArgs(args.slice(id.leading.length), id.home);
  return flags.ok && resolve(flags.socket) === resolve(id.socket);
}

/** True when `handler`, in `group`, is this hook on every call of `event`. */
export function isJevCopsHandler(
  event: RequiredEvent,
  group: Json,
  handler: Json,
  id: HookIdentity,
): boolean {
  if (!NO_MATCHER.has(event) && !MATCH_ALL.has(group.matcher)) return false;
  if (!settled(event, handler)) return false;
  return isOurCommand(handler, id);
}

function registers(groups: unknown, event: RequiredEvent, id: HookIdentity): boolean {
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (g) =>
      isRecord(g) &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isRecord(h) && isJevCopsHandler(event, g, h, id)),
  );
}

/** The required events one settings object registers this hook on. */
export function registeredEvents(settings: Readonly<Json>, id: HookIdentity): Set<RequiredEvent> {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return new Set();
  return new Set(REQUIRED_EVENTS.filter((e) => registers(hooks[e], e, id)));
}

type Read = { readonly file: SettingsFile; readonly read: SettingsRead };

function union(reads: readonly Read[], id: HookIdentity): Set<RequiredEvent> {
  return new Set(
    reads.flatMap((r) => (r.read.kind === "ok" ? [...registeredEvents(r.read.value, id)] : [])),
  );
}

function anySets(reads: readonly Read[], key: string): boolean {
  return reads.some((r) => r.read.kind === "ok" && r.read.value[key] === true);
}

/**
 * Whether the cops hook is still in force given every settings file as it is now
 * (`changed`, when given, is the file the ConfigChange named: invalid JSON there fails).
 */
export function checkIntact(
  reads: readonly Read[],
  id: HookIdentity,
  changed: string | null = null,
): IntactCheck {
  const bad = reads.find((r) => r.file.path === changed && r.read.kind === "invalid");
  if (bad !== undefined) return { intact: false, why: `${bad.file.path} is not valid JSON` };
  const managed = reads.filter((r) => r.file.scope === "managed");
  const others = reads.filter((r) => r.file.scope !== "managed");
  if (anySets(managed, "disableAllHooks"))
    return { intact: false, why: "managed settings set disableAllHooks" };
  const blockedOthers = anySets(others, "disableAllHooks")
    ? "disableAllHooks is set"
    : anySets(managed, "allowManagedHooksOnly")
      ? "managed settings set allowManagedHooksOnly"
      : null;
  const inForce = new Set([
    ...union(managed, id),
    ...(blockedOthers === null ? union(others, id) : []),
  ]);
  const missing = REQUIRED_EVENTS.filter((e) => !inForce.has(e));
  if (missing.length === 0)
    return { intact: true, why: "the cops hook is registered on every required event" };
  const cause = blockedOthers ?? "the cops hook entry is missing or altered";
  return { intact: false, why: `${cause}: no cops hook on ${missing.join(", ")}` };
}
