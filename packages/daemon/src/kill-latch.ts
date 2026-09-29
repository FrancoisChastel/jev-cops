import { Database, type Statement } from "bun:sqlite";

/** What latched a session: a `kill` verdict, or a config change that broke the hook block. */
export type LatchCause = "kill" | "config-change";

/** One latched session. */
export interface KillRecord {
  readonly sessionId: string;
  readonly rootId: string;
  readonly at: number;
  readonly cause: LatchCause;
  /** The event (judged call or session report) that latched it. */
  readonly eventId: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_kills (
  session_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, at INTEGER NOT NULL,
  cause TEXT NOT NULL, event_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS session_kills_root ON session_kills (root_id);`;

const SQL = {
  put: `INSERT OR IGNORE INTO session_kills (session_id, root_id, at, cause, event_id)
    VALUES ($sid, $root, $at, $cause, $eventId)`,
  find: `SELECT * FROM session_kills WHERE session_id IN ($sid, $root)
    ORDER BY at, session_id LIMIT 1`,
  clear: "DELETE FROM session_kills WHERE root_id = $root OR session_id = $root",
  count: "SELECT COUNT(DISTINCT root_id) AS n FROM session_kills",
} as const;

type Bindings = Record<string, string | number | null>;
type Statements = { [K in keyof typeof SQL]: Statement<unknown, [Bindings]> };

interface KillRow {
  session_id: string;
  root_id: string;
  at: number;
  cause: string;
  event_id: string;
}

function toRecord(r: KillRow): KillRecord {
  return {
    sessionId: r.session_id,
    rootId: r.root_id,
    at: r.at,
    cause: r.cause === "config-change" ? "config-change" : "kill",
    eventId: r.event_id,
  };
}

/**
 * The kill latch (spec: `kill` is "deny plus session terminated"; Claude Code offers no
 * process kill from a hook). Once a session is latched, it and its root stay latched in
 * SQLite across restarts; `/v1/judge` answers `kill` for them without running a policy.
 * Nothing on the agent surface clears a latch: only the admin socket's unlatch does, and
 * session GC does not.
 */
export class KillLatch {
  private readonly db: Database;
  private readonly st: Statements;
  private readonly now: () => number;
  private closed = false;

  constructor(path: string, now: () => number = Date.now) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const entries = Object.entries(SQL).map(([k, sql]) => [k, this.db.prepare(sql)]);
    this.st = Object.fromEntries(entries) as Statements;
    this.now = now;
  }

  /** Latches `sessionId` and its root; an existing latch keeps its first cause. */
  latch(sessionId: string, rootId: string, cause: LatchCause, eventId: string): void {
    const at = this.now();
    this.db.transaction(() => {
      for (const sid of new Set([rootId, sessionId])) {
        this.st.put.run({ sid, root: rootId, at, cause, eventId });
      }
    })();
  }

  /** The latch covering `sessionId` (itself or its root), or null. */
  find(sessionId: string, rootId: string): KillRecord | null {
    const row = this.st.find.get({ sid: sessionId, root: rootId }) as KillRow | null;
    return row === null ? null : toRecord(row);
  }

  /** Clears every latch under root `rootId`; returns how many were cleared. */
  unlatch(rootId: string): number {
    return this.st.clear.run({ root: rootId }).changes;
  }

  /** How many root sessions are latched. */
  count(): number {
    return (this.st.count.get({}) as { n: number }).n;
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.st)) s.finalize();
    this.db.close();
  }
}
