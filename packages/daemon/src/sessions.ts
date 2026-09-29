import { Database, type Statement } from "bun:sqlite";
import {
  type CaseFile,
  type ContextConfigInput,
  type Event,
  openCaseFile,
  type RiskBudget,
  resetBudget,
  SqliteCaseFileStore,
} from "@jevdict/core";

/** A root session idle this long is closed: its precedents end, its case file stays. */
export const SESSION_IDLE_MS = 24 * 3_600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_activity (
  session_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  closed_at INTEGER);`;

const SQL = {
  touch: `INSERT INTO session_activity (session_id, first_seen_at, last_seen_at, closed_at)
    VALUES ($sid, $now, $now, NULL)
    ON CONFLICT (session_id) DO UPDATE SET last_seen_at = $now, closed_at = NULL`,
  known: "SELECT closed_at FROM session_activity WHERE session_id = $sid",
  idle: `SELECT session_id FROM session_activity
    WHERE closed_at IS NULL AND last_seen_at < $cutoff ORDER BY session_id`,
  close: "UPDATE session_activity SET closed_at = $now WHERE session_id = $sid",
} as const;

type Bindings = Record<string, string | number | null>;
type Statements = { [K in keyof typeof SQL]: Statement<unknown, [Bindings]> };

/** Clock, context config (thresholds, `home`) and the idle cut-off. */
export interface SessionStoreOptions {
  now?: () => number;
  contextConfig?: ContextConfigInput;
  idleMs?: number;
}

/**
 * The daemon's case files, keyed by session id (SQLite, the `[store] path`). Subagents
 * are linked to their parent's root through `session.parent_id` and share its case file
 * by reference; the task is captured from the first event that carries one and is
 * immutable afterwards (T11). Activity is tracked per root session for inactivity GC.
 */
export class SessionStore {
  private readonly cases: SqliteCaseFileStore;
  private readonly db: Database;
  private readonly st: Statements;
  private readonly now: () => number;
  private readonly idleMs: number;
  private closed = false;

  constructor(path: string, opts: SessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    this.cases = new SqliteCaseFileStore(path, {
      now: this.now,
      ...(opts.contextConfig === undefined ? {} : { config: opts.contextConfig }),
    });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const entries = Object.entries(SQL).map(([k, sql]) => [k, this.db.prepare(sql)]);
    this.st = Object.fromEntries(entries) as Statements;
  }

  /**
   * The case file for `event`'s session (a subagent's view of its root's), created on
   * first sight. Sets the task once from `session.task` and marks the root active.
   */
  open(event: Event): CaseFile {
    const cf = this.openSession(event.session.id, event.session.parent_id);
    if (event.session.task !== undefined && event.session.task !== "") {
      cf.setTaskOnce(event.session.task);
    }
    return cf;
  }

  /**
   * The case file of session `sessionId` (linked under `parentId` when set), created on
   * first sight; marks its root active. `/v1/session` reports open sessions this way.
   */
  openSession(sessionId: string, parentId: string | null): CaseFile {
    const cf = openCaseFile(this.cases, sessionId, parentId);
    this.st.touch.run({ sid: this.rootOf(sessionId), now: this.now() });
    return cf;
  }

  /** Closes `sessionId`'s root now (a session `end` report); false when unknown or closed. */
  closeRoot(sessionId: string): boolean {
    if (!this.isOpen(sessionId)) return false;
    this.st.close.run({ sid: this.rootOf(sessionId), now: this.now() });
    return true;
  }

  /** The root session `sessionId` belongs to (itself when not a subagent). */
  rootOf(sessionId: string): string {
    return this.cases.rootOf(sessionId);
  }

  private known(sessionId: string): { closedAt: number | null } | null {
    const row = this.st.known.get({ sid: this.rootOf(sessionId) }) as {
      closed_at: number | null;
    } | null;
    return row === null ? null : { closedAt: row.closed_at };
  }

  /** True while the session's root has been seen and not closed by GC. */
  isOpen(sessionId: string): boolean {
    const k = this.known(sessionId);
    return k !== null && k.closedAt === null;
  }

  /** The stored budget of a known session, else null. */
  budget(sessionId: string): RiskBudget | null {
    if (this.known(sessionId) === null) return null;
    return this.cases.root(this.rootOf(sessionId)).budget;
  }

  /** A human reset (spec: "until a human resets the budget"); null for unknown sessions. */
  resetBudget(sessionId: string): RiskBudget | null {
    if (this.known(sessionId) === null) return null;
    const cf = this.cases.root(this.rootOf(sessionId));
    const next = resetBudget(cf.budget, this.now());
    cf.setBudget(next);
    return next;
  }

  /** Closes root sessions idle longer than the cut-off; returns their ids. */
  gc(): string[] {
    const now = this.now();
    const rows = this.st.idle.all({ cutoff: now - this.idleMs }) as { session_id: string }[];
    const ids = rows.map((r) => r.session_id);
    this.db.transaction(() => {
      for (const sid of ids) this.st.close.run({ sid, now });
    })();
    return ids;
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.st)) s.finalize();
    this.db.close();
    this.cases.close();
  }
}
