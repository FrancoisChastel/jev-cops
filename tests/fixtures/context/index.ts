import { normalize } from "../../../packages/core/src/normalizer/normalize.ts";
import type { NormalizedEvent } from "../../../packages/core/src/normalizer/types.ts";
import { type Event, type Harness, parseEvent } from "../../../packages/core/src/schema/event.ts";
import { loadEventFixture } from "../events/index.ts";

/** Home directory every context fixture expands `~` to. */
export const CTX_HOME = "/home/dev";
/** Repo and cwd of every context fixture unless overridden. */
export const CTX_REPO = "/work/repo";
/** Root session id of the canonical fixtures. */
export const CTX_SESSION = "sess_01M3PP6ZQ4A7X9V2K3JH8N5B6C";

type Json = Record<string, unknown>;

/** What a test may change on top of the canonical `pre-bash` fixture. */
export interface EventShape {
  callId?: string;
  cwd?: string;
  sessionId?: string;
  parentId?: string | null;
  task?: string;
  mode?: "interactive" | "headless";
  actor?: "agent" | "subagent" | "user";
  git?: Json | null;
  sandbox?: "openshell" | "none";
  /** The harness that sent the call (default: the fixture's, Claude Code). */
  harness?: Harness;
}

/** Result fields of a post event. */
export interface ResultShape {
  stdout?: string;
  ok?: boolean;
  exitCode?: number;
}

let counter = 0;

function nextCallId(): string {
  counter += 1;
  return `call_ctx_${counter}`;
}

function sessionOf(base: Json, shape: EventShape): Json {
  const session = { ...(base.session as Json) };
  const patch: Json = {
    ...(shape.sessionId === undefined ? {} : { id: shape.sessionId }),
    ...(shape.parentId === undefined ? {} : { parent_id: shape.parentId }),
    ...(shape.task === undefined ? {} : { task: shape.task }),
    ...(shape.mode === undefined ? {} : { mode: shape.mode }),
  };
  return { ...session, ...patch };
}

function envOf(base: Json, shape: EventShape): Json {
  const env = base.env as Json;
  const git = shape.git === undefined ? env.git : shape.git;
  const sandbox = shape.sandbox === undefined ? env.sandbox : { kind: shape.sandbox };
  return { ...(git === null ? {} : { git }), sandbox };
}

/** Builds a validated event from the `pre-bash` fixture with a new tool call. */
export function buildEvent(
  call: { tool: string; kind: string; input: Json },
  shape: EventShape = {},
  result?: ResultShape,
): Event {
  const base = loadEventFixture("pre-bash") as Json;
  const raw: Json = {
    ...base,
    ...(shape.harness === undefined ? {} : { harness: shape.harness }),
    phase: result === undefined ? "pre" : "post",
    session: sessionOf(base, shape),
    actor: { kind: shape.actor ?? "agent" },
    call: { id: shape.callId ?? nextCallId(), cwd: shape.cwd ?? CTX_REPO, ...call },
    env: envOf(base, shape),
    ...(result === undefined
      ? {}
      : {
          result: {
            ok: result.ok ?? true,
            ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
            stdout_head: result.stdout ?? "",
          },
        }),
  };
  const parsed = parseEvent(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

/** A normalized Bash pre event. */
export function bashPre(command: string, shape: EventShape = {}): Promise<NormalizedEvent> {
  return normalize(buildEvent(bashCall(command), shape), { home: CTX_HOME });
}

/** A normalized Bash post event carrying `result`. */
export function bashPost(
  command: string,
  result: ResultShape,
  shape: EventShape = {},
): Promise<NormalizedEvent> {
  return normalize(buildEvent(bashCall(command), shape, result), { home: CTX_HOME });
}

/** A normalized pre (no `result`) or post event for any tool. */
export function toolEvent(
  tool: string,
  kind: string,
  input: Json,
  shape: EventShape = {},
  result?: ResultShape,
): Promise<NormalizedEvent> {
  return normalize(buildEvent({ tool, kind, input }, shape, result), { home: CTX_HOME });
}

function bashCall(command: string): { tool: string; kind: string; input: Json } {
  return { tool: "Bash", kind: "exec", input: { command } };
}

/** A mutable clock for injecting `now` into case files. */
export interface TestClock {
  now: () => number;
  set(at: number): void;
  advance(ms: number): void;
}

/** A clock starting at `start` that only moves when the test moves it. */
export function testClock(start = 1_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    set: (at) => {
      current = at;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
