import { Database, type Statement } from "bun:sqlite";
import type { CallKind, Phase } from "../schema/event.ts";
import type { RiskBudget } from "./budget.ts";
import { type CaseFileStore, caseFileOptions, type StoreOptions } from "./casefile.ts";
import { CaseFileEngine, type CaseFileOptions, type CaseFileStorage } from "./casefile-core.ts";
import type { CallRecord, CaseFile, FileWrite, HostSeen, SecretRead, TaintEntry } from "./types.ts";

/**
 * Case-file schema. Every row is keyed by the *root* session id; a subagent's calls are
 * stored under its root with `issuer_id` naming the subagent.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, task TEXT, failures INTEGER NOT NULL DEFAULT 0, budget TEXT);
CREATE TABLE IF NOT EXISTS session_links (session_id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (
  session_id TEXT NOT NULL, call_id TEXT NOT NULL, issuer_id TEXT NOT NULL, at INTEGER NOT NULL,
  phase TEXT NOT NULL, kind TEXT NOT NULL, verbs TEXT NOT NULL, paths TEXT NOT NULL,
  hosts TEXT NOT NULL, argv TEXT NOT NULL, taint REAL NOT NULL, ok INTEGER, exit_code INTEGER,
  PRIMARY KEY (session_id, call_id));
CREATE INDEX IF NOT EXISTS calls_at ON calls (session_id, at);
CREATE TABLE IF NOT EXISTS taint (
  session_id TEXT NOT NULL, value TEXT NOT NULL, source_call_id TEXT NOT NULL,
  at INTEGER NOT NULL, taint REAL NOT NULL, PRIMARY KEY (session_id, value));
CREATE TABLE IF NOT EXISTS secret_reads (
  session_id TEXT NOT NULL, path TEXT NOT NULL, call_id TEXT NOT NULL, at INTEGER NOT NULL,
  reason TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS secret_reads_at ON secret_reads (session_id, at);
CREATE TABLE IF NOT EXISTS hosts (
  session_id TEXT NOT NULL, host TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
  call_id TEXT NOT NULL, PRIMARY KEY (session_id, host));
CREATE TABLE IF NOT EXISTS files (
  session_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, taint REAL NOT NULL,
  call_id TEXT NOT NULL, at INTEGER NOT NULL, executable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, path));
CREATE TABLE IF NOT EXISTS anomalies (session_id TEXT NOT NULL, message TEXT NOT NULL);
`;

interface CallRow {
  call_id: string;
  issuer_id: string;
  at: number;
  phase: string;
  kind: string;
  verbs: string;
  paths: string;
  hosts: string;
  argv: string;
  taint: number;
  ok: number | null;
  exit_code: number | null;
}

interface FileRow {
  path: string;
  sha256: string | null;
  taint: number;
  call_id: string;
  at: number;
  executable: number;
}

interface TaintRow {
  value: string;
  source_call_id: string;
  at: number;
  taint: number;
}

interface HostRow {
  host: string;
  first_seen_at: number;
  call_id: string;
}

interface SessionRow {
  task: string | null;
  failures: number;
  budget: string | null;
}

type Bindings = Record<string, string | number | null>;

const SQL = {
  session: "SELECT task, failures, budget FROM sessions WHERE session_id = $sid",
  addSession: "INSERT OR IGNORE INTO sessions (session_id) VALUES ($sid)",
  setTask: "UPDATE sessions SET task = $task WHERE session_id = $sid",
  setFailures: "UPDATE sessions SET failures = $count WHERE session_id = $sid",
  setBudget: "UPDATE sessions SET budget = $budget WHERE session_id = $sid",
  link: "INSERT OR IGNORE INTO session_links (session_id, root_id) VALUES ($sid, $root)",
  rootOf: "SELECT root_id FROM session_links WHERE session_id = $sid",
  call: "SELECT * FROM calls WHERE session_id = $sid AND call_id = $callId",
  calls: "SELECT * FROM calls WHERE session_id = $sid AND at >= $since ORDER BY at, rowid",
  putCall: `INSERT INTO calls (session_id, call_id, issuer_id, at, phase, kind, verbs, paths,
      hosts, argv, taint, ok, exit_code)
    VALUES ($sid, $callId, $issuer, $at, $phase, $kind, $verbs, $paths, $hosts, $argv, $taint,
      $ok, $exitCode)
    ON CONFLICT (session_id, call_id) DO UPDATE SET issuer_id = excluded.issuer_id,
      at = excluded.at, phase = excluded.phase, kind = excluded.kind, verbs = excluded.verbs,
      paths = excluded.paths, hosts = excluded.hosts, argv = excluded.argv,
      taint = excluded.taint, ok = excluded.ok, exit_code = excluded.exit_code`,
  taint:
    "SELECT value, source_call_id, at, taint FROM taint WHERE session_id = $sid ORDER BY rowid",
  putTaint: `INSERT INTO taint (session_id, value, source_call_id, at, taint)
    VALUES ($sid, $value, $source, $at, $taint)
    ON CONFLICT (session_id, value) DO UPDATE SET source_call_id = excluded.source_call_id,
      at = excluded.at, taint = excluded.taint`,
  secrets: `SELECT path, call_id, at, reason FROM secret_reads
    WHERE session_id = $sid AND at >= $since ORDER BY at, rowid`,
  addSecret: `INSERT INTO secret_reads (session_id, path, call_id, at, reason)
    VALUES ($sid, $path, $callId, $at, $reason)`,
  hosts: "SELECT host, first_seen_at, call_id FROM hosts WHERE session_id = $sid ORDER BY rowid",
  addHost: `INSERT OR IGNORE INTO hosts (session_id, host, first_seen_at, call_id)
    VALUES ($sid, $host, $at, $callId)`,
  files: "SELECT * FROM files WHERE session_id = $sid ORDER BY rowid",
  putFile: `INSERT INTO files (session_id, path, sha256, taint, call_id, at, executable)
    VALUES ($sid, $path, $sha256, $taint, $callId, $at, $executable)
    ON CONFLICT (session_id, path) DO UPDATE SET sha256 = excluded.sha256,
      taint = excluded.taint, call_id = excluded.call_id, at = excluded.at,
      executable = excluded.executable`,
  anomalies: "SELECT message FROM anomalies WHERE session_id = $sid ORDER BY rowid",
  addAnomaly: "INSERT INTO anomalies (session_id, message) VALUES ($sid, $message)",
} as const;

type Statements = { [K in keyof typeof SQL]: Statement<unknown, [Bindings]> };

function prepareAll(db: Database): Statements {
  const entries = Object.entries(SQL).map(([name, sql]) => [name, db.prepare(sql)]);
  return Object.fromEntries(entries) as Statements;
}

function strings(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function toCall(row: CallRow): CallRecord {
  return {
    callId: row.call_id,
    sessionId: row.issuer_id,
    at: row.at,
    phase: row.phase as Phase,
    kind: row.kind as CallKind,
    verbs: strings(row.verbs),
    paths: strings(row.paths),
    hosts: strings(row.hosts),
    argv: strings(row.argv),
    taint: row.taint,
    ...(row.ok === null ? {} : { ok: row.ok === 1 }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
  };
}

function toFile(row: FileRow): FileWrite {
  return {
    path: row.path,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    taint: row.taint,
    callId: row.call_id,
    at: row.at,
    ...(row.executable === 1 ? { executable: true } : {}),
  };
}

/** {@link CaseFileStorage} over one root session's rows in a shared database. */
class SqliteStorage implements CaseFileStorage {
  constructor(
    private readonly db: Database,
    private readonly st: Statements,
    private readonly sid: string,
  ) {}

  private session(): SessionRow {
    const row = this.st.session.get({ sid: this.sid }) as SessionRow | null;
    return row ?? { task: null, failures: 0, budget: null };
  }

  private run(name: keyof Statements, params: Bindings): void {
    this.st[name].run({ sid: this.sid, ...params });
  }

  private batch<T>(items: ReadonlyArray<T>, fn: (item: T) => void): void {
    if (items.length > 0) this.db.transaction(() => items.forEach(fn))();
  }

  readTask(): string | null {
    return this.session().task;
  }
  writeTask(task: string): void {
    this.run("setTask", { task });
  }
  readCall(callId: string): CallRecord | undefined {
    const row = this.st.call.get({ sid: this.sid, callId }) as CallRow | null;
    return row === null ? undefined : toCall(row);
  }
  writeCall(c: CallRecord): void {
    this.run("putCall", {
      callId: c.callId,
      issuer: c.sessionId,
      at: c.at,
      phase: c.phase,
      kind: c.kind,
      verbs: JSON.stringify(c.verbs),
      paths: JSON.stringify(c.paths),
      hosts: JSON.stringify(c.hosts),
      argv: JSON.stringify(c.argv),
      taint: c.taint,
      ok: c.ok === undefined ? null : c.ok ? 1 : 0,
      exitCode: c.exitCode ?? null,
    });
  }
  readCalls(sinceAt: number): CallRecord[] {
    return (this.st.calls.all({ sid: this.sid, since: sinceAt }) as CallRow[]).map(toCall);
  }
  readTaint(): TaintEntry[] {
    const rows = this.st.taint.all({ sid: this.sid }) as TaintRow[];
    return rows.map((r) => ({
      value: r.value,
      sourceCallId: r.source_call_id,
      at: r.at,
      taint: r.taint,
    }));
  }
  writeTaint(entries: ReadonlyArray<TaintEntry>): void {
    this.batch(entries, (e) =>
      this.run("putTaint", { value: e.value, source: e.sourceCallId, at: e.at, taint: e.taint }),
    );
  }
  readSecretReads(sinceAt: number): SecretRead[] {
    const rows = this.st.secrets.all({ sid: this.sid, since: sinceAt }) as {
      path: string;
      call_id: string;
      at: number;
      reason: SecretRead["reason"];
    }[];
    return rows.map((r) => ({ path: r.path, callId: r.call_id, at: r.at, reason: r.reason }));
  }
  addSecretReads(reads: ReadonlyArray<SecretRead>): void {
    this.batch(reads, (r) =>
      this.run("addSecret", { path: r.path, callId: r.callId, at: r.at, reason: r.reason }),
    );
  }
  readHosts(): Map<string, HostSeen> {
    const rows = this.st.hosts.all({ sid: this.sid }) as HostRow[];
    return new Map(rows.map((r) => [r.host, { at: r.first_seen_at, callId: r.call_id }]));
  }
  addHosts(hosts: ReadonlyArray<string>, at: number, callId: string): void {
    this.batch(hosts, (host) => this.run("addHost", { host, at, callId }));
  }
  readFiles(): Map<string, FileWrite> {
    const rows = this.st.files.all({ sid: this.sid }) as FileRow[];
    return new Map(rows.map((r) => [r.path, toFile(r)]));
  }
  writeFiles(files: ReadonlyArray<FileWrite>): void {
    this.batch(files, (f) =>
      this.run("putFile", {
        path: f.path,
        sha256: f.sha256 ?? null,
        taint: f.taint,
        callId: f.callId,
        at: f.at,
        executable: f.executable === true ? 1 : 0,
      }),
    );
  }
  readFailures(): number {
    return this.session().failures;
  }
  writeFailures(count: number): void {
    this.run("setFailures", { count });
  }
  readBudget(): RiskBudget | null {
    const json = this.session().budget;
    return json === null ? null : (JSON.parse(json) as RiskBudget);
  }
  writeBudget(budget: RiskBudget): void {
    this.run("setBudget", { budget: JSON.stringify(budget) });
  }
  readAnomalies(): string[] {
    const rows = this.st.anomalies.all({ sid: this.sid }) as { message: string }[];
    return rows.map((r) => r.message);
  }
  addAnomaly(message: string): void {
    this.run("addAnomaly", { message });
  }
}

/**
 * Case files in SQLite (`bun:sqlite`): a file path or `:memory:`. One database holds
 * many sessions; the schema is created idempotently, file databases run in WAL mode,
 * and every query is a prepared statement with bound parameters.
 */
export class SqliteCaseFileStore implements CaseFileStore {
  private readonly db: Database;
  private readonly st: Statements;
  private readonly options: CaseFileOptions;
  private readonly open = new Map<string, CaseFile>();

  constructor(path: string, opts: StoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.st = prepareAll(this.db);
    this.options = caseFileOptions(opts);
  }

  root(rootSessionId: string): CaseFile {
    const cached = this.open.get(rootSessionId);
    if (cached !== undefined) return cached;
    this.st.addSession.run({ sid: rootSessionId });
    const storage = new SqliteStorage(this.db, this.st, rootSessionId);
    const created = new CaseFileEngine(rootSessionId, storage, this.options);
    this.open.set(rootSessionId, created);
    return created;
  }

  link(sessionId: string, parentId: string): string {
    const root = this.rootOf(parentId);
    if (root !== sessionId) this.st.link.run({ sid: sessionId, root });
    return this.rootOf(sessionId);
  }

  rootOf(sessionId: string): string {
    const row = this.st.rootOf.get({ sid: sessionId }) as { root_id: string } | null;
    return row?.root_id ?? sessionId;
  }

  /** The database's journal mode (`wal` for files, `memory` for `:memory:`). */
  journalMode(): string {
    const row = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    return row?.journal_mode ?? "";
  }

  close(): void {
    for (const st of Object.values(this.st)) st.finalize();
    this.db.close();
  }
}
