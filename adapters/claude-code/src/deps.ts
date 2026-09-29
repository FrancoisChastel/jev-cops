/**
 * What the hook runtime needs from its process, injected so every path (including the
 * failures) is testable in-process: the daemon client, the deadlines, the session mode and
 * Claude Code version (read lazily), and the local log.
 */
import type { SessionMode } from "@jevdict/core";
import type { DaemonClient } from "./client.ts";
import type { IntactCheck } from "./intact.ts";
import type { HookLogLine } from "./log.ts";
import type { ConfigChangeInput } from "./payload.ts";

/** Time limits in milliseconds. */
export interface Deadlines {
  /** Whole `PreToolUse` run: the daemon's 12 s judge deadline + 1 s, < the settings timeout 30 s (T3). */
  readonly judgeMs: number;
  /** Whole run of any other event (the installer registers them with a 10 s timeout). */
  readonly eventMs: number;
  /** One short request: observe (D-057 parity), session reports, the confirm view. */
  readonly requestMs: number;
}

/** The deadlines of a real run. */
export const DEFAULT_DEADLINES: Deadlines = Object.freeze({
  judgeMs: 13_000,
  eventMs: 5_000,
  requestMs: 2_000,
});

/**
 * Lowers every deadline to at most this many milliseconds (tests, slow-daemon drills). It
 * can only shorten them, so it can only turn more calls into "judge timeout" blocks.
 */
export const DEADLINE_ENV = "JEVDICT_HOOK_DEADLINE_MS";
const MIN_DEADLINE_MS = 50;

/** {@link DEFAULT_DEADLINES}, each capped by `$JEVDICT_HOOK_DEADLINE_MS` when it is a number. */
export function deadlinesFrom(env: Readonly<Record<string, string | undefined>>): Deadlines {
  const raw = Number(env[DEADLINE_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DEADLINES;
  const cap = Math.max(MIN_DEADLINE_MS, Math.floor(raw));
  return {
    judgeMs: Math.min(DEFAULT_DEADLINES.judgeMs, cap),
    eventMs: Math.min(DEFAULT_DEADLINES.eventMs, cap),
    requestMs: Math.min(DEFAULT_DEADLINES.requestMs, cap),
  };
}

/**
 * `d` after `ms` were already spent in this run (reading stdin): the run-wide deadlines
 * shrink, at least 1 ms each, so the whole process stays under Claude Code's timeout.
 */
export function spend(d: Deadlines, ms: number): Deadlines {
  const left = (limit: number) => Math.max(1, Math.floor(limit - Math.max(0, ms)));
  return { judgeMs: left(d.judgeMs), eventMs: left(d.eventMs), requestMs: d.requestMs };
}

/** Everything {@link runHook} reads beyond its stdin. */
export interface HookDeps {
  readonly client: DaemonClient;
  readonly deadlines: Deadlines;
  /** The session mode (parent argv, mode.ts); called at most once per run. */
  readonly mode: () => SessionMode;
  /** The recorded `claude --version`, or null (state.ts). */
  readonly harnessVersion: () => string | null;
  /** Appends to the local log; never throws. */
  readonly log: (line: HookLogLine) => void;
  /** Whether the jevdict hook is still in force after a settings change (intact.ts). */
  readonly configCheck: (i: ConfigChangeInput) => IntactCheck;
}
