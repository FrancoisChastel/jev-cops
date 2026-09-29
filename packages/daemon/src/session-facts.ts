import { Database, type Statement } from "bun:sqlite";
import {
  NO_HUMAN_PERMISSION_MODES,
  PERMISSION_MODES,
  SESSION_MODES,
  type SessionEvent,
  type SessionMode,
} from "@jevdict/core";

/**
 * Why no human can answer a `hold` in a session, so it must become `deny` (D-008):
 * the session runs headless, or its harness permission mode never prompts
 * (`dontAsk`, `bypassPermissions`, or a mode jevdict does not know).
 */
export type NoHumanReason = "headless" | "permission-mode";

/** What `/v1/session` reports taught the daemon about a root session. */
export interface SessionFacts {
  /** Pinned by the first report; later reports cannot change it. */
  readonly harness: string | null;
  readonly harnessVersion: string | null;
  readonly model: string | null;
  readonly mode: SessionMode | null;
  /** The last permission mode reported. */
  readonly permissionMode: string | null;
  /** Sticky: once any report showed no human, holds stay denies for the session. */
  readonly noHuman: NoHumanReason | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_facts (
  root_id TEXT PRIMARY KEY, harness TEXT, harness_version TEXT, model TEXT, mode TEXT,
  permission_mode TEXT, no_human TEXT, updated_at INTEGER NOT NULL);`;

const SQL = {
  get: "SELECT * FROM session_facts WHERE root_id = $root",
  put: `INSERT OR REPLACE INTO session_facts (root_id, harness, harness_version, model, mode,
    permission_mode, no_human, updated_at) VALUES ($root, $harness, $version, $model, $mode,
    $permission, $noHuman, $now)`,
} as const;

type Bindings = Record<string, string | number | null>;
type Statements = { [K in keyof typeof SQL]: Statement<unknown, [Bindings]> };

interface FactsRow {
  harness: string | null;
  harness_version: string | null;
  model: string | null;
  mode: string | null;
  permission_mode: string | null;
  no_human: string | null;
}

const KNOWN_MODES: ReadonlySet<string> = new Set(PERMISSION_MODES);
const NO_HUMAN_MODES: ReadonlySet<string> = new Set(NO_HUMAN_PERMISSION_MODES);

/**
 * The no-human reason for a session mode and a permission mode: `headless` first, then a
 * permission mode that never prompts. An unknown permission mode counts as no human
 * (missing information is exposure, D-024): the worst it does is turn a hold into a deny.
 */
export function noHumanOf(
  mode: SessionMode | null | undefined,
  permissionMode: string | null | undefined,
): NoHumanReason | null {
  if (mode === "headless") return "headless";
  if (permissionMode === null || permissionMode === undefined) return null;
  return NO_HUMAN_MODES.has(permissionMode) || !KNOWN_MODES.has(permissionMode)
    ? "permission-mode"
    : null;
}

function asMode(value: string | null): SessionMode | null {
  return (SESSION_MODES as readonly string[]).includes(value ?? "") ? (value as SessionMode) : null;
}

function asNoHuman(value: string | null): NoHumanReason | null {
  return value === "headless" || value === "permission-mode" ? value : null;
}

function toFacts(r: FactsRow): SessionFacts {
  return {
    harness: r.harness,
    harnessVersion: r.harness_version,
    model: r.model,
    mode: asMode(r.mode),
    permissionMode: r.permission_mode,
    noHuman: asNoHuman(r.no_human),
  };
}

const EMPTY: SessionFacts = {
  harness: null,
  harnessVersion: null,
  model: null,
  mode: null,
  permissionMode: null,
  noHuman: null,
};

/**
 * `prev` updated by one report: later values win, except the harness (pinned by the first
 * report, so an agent cannot re-declare a Claude Code session as Pi to get resolvable
 * holds) and `noHuman` (never clears).
 */
export function mergeFacts(prev: SessionFacts, r: SessionEvent): SessionFacts {
  const mode = r.session.mode ?? prev.mode;
  const permissionMode = r.permission_mode ?? prev.permissionMode;
  return {
    harness: prev.harness ?? r.harness,
    harnessVersion: r.harness_version ?? prev.harnessVersion,
    model: (r.kind === "start" ? r.model : undefined) ?? prev.model,
    mode,
    permissionMode,
    noHuman: prev.noHuman ?? noHumanOf(mode, permissionMode),
  };
}

/**
 * Session facts from `/v1/session` reports (SQLite, the `[store] path`), keyed by root
 * session so subagents share them: harness and version, model, mode and permission mode.
 * `/v1/judge` reads the no-human flag to map a `hold` to `deny`; the Claude Code post
 * mapper reads the version, mode and model.
 */
export class SessionFactsStore {
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

  /** The facts of root session `rootId`, or null when it never reported. */
  get(rootId: string): SessionFacts | null {
    const row = this.st.get.get({ root: rootId }) as FactsRow | null;
    return row === null ? null : toFacts(row);
  }

  /** Merges one report into the facts of `rootId`; returns the new facts. */
  record(rootId: string, r: SessionEvent): SessionFacts {
    const next = mergeFacts(this.get(rootId) ?? EMPTY, r);
    this.st.put.run({
      root: rootId,
      harness: next.harness,
      version: next.harnessVersion,
      model: next.model,
      mode: next.mode,
      permission: next.permissionMode,
      noHuman: next.noHuman,
      now: this.now(),
    });
    return next;
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.st)) s.finalize();
    this.db.close();
  }
}
