import { type Event, type Harness, mintEventId, type SessionEventKind } from "@jev-cops/core";

/** The root session id the session-route tests use unless they pass another. */
export const TEST_SESSION = "sess_01M3PP6ZQ4A7X9V2K3JH8N5B6C";

type Json = Record<string, unknown>;

/** What a test may set on a `jev-cops.session/1` report besides its kind-specific fields. */
export interface ReportShape {
  sessionId?: string;
  parentId?: string | null;
  mode?: "interactive" | "headless";
  harness?: Harness;
  permissionMode?: string;
}

/**
 * A `jev-cops.session/1` report with a fresh id. `fields` are the kind-specific ones
 * (`prompt`, `model`, `source`, `intact`, …); `start` gets a cwd and an interactive mode
 * unless the shape or fields say otherwise.
 */
export function sessionReport(kind: SessionEventKind, fields: Json = {}, shape: ReportShape = {}) {
  const mode = shape.mode ?? (kind === "start" ? "interactive" : undefined);
  const session = {
    id: shape.sessionId ?? TEST_SESSION,
    ...(shape.parentId === undefined ? {} : { parent_id: shape.parentId }),
    ...(mode === undefined ? {} : { mode }),
  };
  return {
    schema: "jev-cops.session/1",
    id: mintEventId(),
    harness: shape.harness ?? "claude-code",
    session,
    kind,
    ...(kind === "start" ? { cwd: "/work/repo" } : {}),
    ...(shape.permissionMode === undefined ? {} : { permission_mode: shape.permissionMode }),
    ...fields,
  };
}

/** The same event from another harness: holds on Pi still mint a resolvable token. */
export function withHarness<E extends Event>(e: E, harness: Harness): E {
  return { ...e, harness };
}
