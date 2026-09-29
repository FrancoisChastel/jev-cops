import { Database, type Statement } from "bun:sqlite";
import type { PolicyContext, PolicyEvent, PrecedentLookup, PrecedentMatch } from "@jevdict/core";
import { hashHoldToken, sameHash } from "./hold-tokens.ts";
import { matchScore, type PrecedentScope, scopeKey, taskHash } from "./precedent-scope.ts";

export {
  matchScore,
  type PrecedentScope,
  proposeScope,
  type ScopeSource,
  scopeKey,
  taskHash,
} from "./precedent-scope.ts";

/** Hard cap on a precedent's life, whatever its session does (and on a pending hold's). */
export const PRECEDENT_MAX_AGE_MS = 24 * 3_600_000;
/** How far a precedent lowers risk; core caps it at 0.3 too (spec §Precedents). */
export const PRECEDENT_RISK_DELTA = 0.3;

/** A human-granted precedent. `expiresAt` null: valid until its session closes. */
export interface Precedent {
  readonly key: string;
  /** The root session it belongs to; subagents share it. */
  readonly sessionId: string;
  readonly scope: PrecedentScope;
  readonly riskDelta: number;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  /** Names of the policies whose non-deny verdict the human overrode (core waives by name). */
  readonly policies: readonly string[];
  readonly eventId: string;
  readonly by: string;
}

/** A `hold` the harness showed a human, waiting for `POST /v1/resolve`. */
export interface PendingHold {
  readonly eventId: string;
  readonly sessionId: string;
  readonly scope: PrecedentScope;
  readonly policies: readonly string[];
}

/** The stored side of a hold token: its hash and when it stops being accepted. */
export interface HoldTokenRecord {
  readonly hash: string;
  readonly expiresAt: number;
}

/** Why a presented hold token was refused; recorded on the `anomaly` audit line. */
export type RedeemFailure = "no-token" | "no-hold" | "mismatch" | "reused" | "expired";

/** A redeemed hold, or why the token was refused. */
export type Redeemed =
  | { readonly ok: true; readonly hold: PendingHold }
  | { readonly ok: false; readonly why: RedeemFailure };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS precedents (
  key TEXT NOT NULL, session_id TEXT NOT NULL, scope TEXT NOT NULL, risk_delta REAL NOT NULL,
  granted_at INTEGER NOT NULL, expires_at INTEGER, policies TEXT NOT NULL,
  event_id TEXT NOT NULL, granted_by TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS precedents_session ON precedents (session_id);
CREATE TABLE IF NOT EXISTS holds (
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL,
  policies TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hold_tokens (
  event_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER);
`;

const SQL = {
  insert: `INSERT INTO precedents (key, session_id, scope, risk_delta, granted_at, expires_at,
    policies, event_id, granted_by) VALUES ($key, $sid, $scope, $delta, $granted, $expires,
    $policies, $eventId, $by)`,
  active: `SELECT * FROM precedents WHERE session_id = $sid AND granted_at > $oldest
    AND (expires_at IS NULL OR expires_at > $now) ORDER BY granted_at DESC, rowid DESC`,
  expire: `UPDATE precedents SET expires_at = $now WHERE session_id = $sid
    AND (expires_at IS NULL OR expires_at > $now)`,
  putHold: `INSERT OR REPLACE INTO holds (event_id, session_id, scope, policies, at)
    VALUES ($eventId, $sid, $scope, $policies, $now)`,
  hold: "SELECT * FROM holds WHERE event_id = $eventId AND at > $oldest",
  dropHold: "DELETE FROM holds WHERE event_id = $eventId",
  putToken: `INSERT OR REPLACE INTO hold_tokens (event_id, token_hash, expires_at, used_at)
    VALUES ($eventId, $hash, $expires, NULL)`,
  token: "SELECT * FROM hold_tokens WHERE event_id = $eventId",
  useToken: `UPDATE hold_tokens SET used_at = $now WHERE event_id = $eventId
    AND used_at IS NULL`,
  pruneTokens: "DELETE FROM hold_tokens WHERE expires_at < $oldest",
} as const;

type Bindings = Record<string, string | number | null>;
type Statements = { [K in keyof typeof SQL]: Statement<unknown, [Bindings]> };

interface PrecedentRow {
  key: string;
  session_id: string;
  scope: string;
  risk_delta: number;
  granted_at: number;
  expires_at: number | null;
  policies: string;
  event_id: string;
  granted_by: string;
}

interface TokenRow {
  token_hash: string;
  expires_at: number;
  used_at: number | null;
}

interface HoldRow {
  event_id: string;
  session_id: string;
  scope: string;
  policies: string;
}

function toPrecedent(r: PrecedentRow): Precedent {
  return {
    key: r.key,
    sessionId: r.session_id,
    scope: JSON.parse(r.scope) as PrecedentScope,
    riskDelta: r.risk_delta,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
    policies: JSON.parse(r.policies) as string[],
    eventId: r.event_id,
    by: r.granted_by,
  };
}

/** Clock and session-root resolution the store needs from the daemon. */
export interface PrecedentStoreOptions {
  now?: () => number;
  /** Root session of a (sub)agent session; precedents live on roots. */
  rootOf?: (sessionId: string) => string;
}

/**
 * Precedents in SQLite, implementing core {@link PrecedentLookup}. A precedent exists
 * only because a human allowed a `hold` the daemon recorded, and its scope is the one the
 * daemon proposed at hold time: {@link grant} takes an event id and nothing else (T7/T8).
 * TTL: until the session closes ({@link expireSession}) and at most 24 h. Core caps the
 * risk delta at 0.3 and ignores precedents when a policy says `kill`.
 */
export class PrecedentStore implements PrecedentLookup {
  private readonly db: Database;
  private readonly st: Statements;
  private readonly now: () => number;
  private readonly rootOf: (sessionId: string) => string;
  private closed = false;

  constructor(path: string, opts: PrecedentStoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const entries = Object.entries(SQL).map(([k, sql]) => [k, this.db.prepare(sql)]);
    this.st = Object.fromEntries(entries) as Statements;
    this.now = opts.now ?? Date.now;
    this.rootOf = opts.rootOf ?? ((id) => id);
  }

  /**
   * Remembers a hold shown to a human, with the scope the daemon proposes for it and the
   * hash of the token that may resolve it (a hold recorded without one never resolves).
   * Tokens older than the 24 h hold cap are pruned here.
   */
  recordHold(h: PendingHold, token: HoldTokenRecord | null = null): void {
    const now = this.now();
    this.db.transaction(() => {
      this.st.putHold.run({
        eventId: h.eventId,
        sid: this.rootOf(h.sessionId),
        scope: JSON.stringify(h.scope),
        policies: JSON.stringify(h.policies),
        now,
      });
      if (token !== null) {
        this.st.putToken.run({ eventId: h.eventId, hash: token.hash, expires: token.expiresAt });
      }
      this.st.pruneTokens.run({ oldest: now - PRECEDENT_MAX_AGE_MS });
    })();
  }

  /**
   * Checks `token` against the hold of `eventId` and spends it: the hash is compared in
   * constant time, and a token works once, before it expires, while its hold is pending.
   * The caller then grants or drops the hold; nothing else resolves one.
   */
  redeem(eventId: string, token: string | undefined): Redeemed {
    if (token === undefined || token === "") return { ok: false, why: "no-token" };
    const row = this.st.token.get({ eventId }) as TokenRow | null;
    if (row === null) return { ok: false, why: "no-hold" };
    if (!sameHash(row.token_hash, hashHoldToken(token))) return { ok: false, why: "mismatch" };
    if (row.used_at !== null) return { ok: false, why: "reused" };
    if (row.expires_at <= this.now()) return { ok: false, why: "expired" };
    const hold = this.pendingHold(eventId);
    if (hold === null) return { ok: false, why: "no-hold" };
    this.st.useToken.run({ eventId, now: this.now() });
    return { ok: true, hold };
  }

  /** The pending hold for `eventId`, or null (unknown, resolved, or older than 24 h). */
  pendingHold(eventId: string): PendingHold | null {
    const oldest = this.now() - PRECEDENT_MAX_AGE_MS;
    const row = this.st.hold.get({ eventId, oldest }) as HoldRow | null;
    if (row === null) return null;
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      scope: JSON.parse(row.scope) as PrecedentScope,
      policies: JSON.parse(row.policies) as string[],
    };
  }

  /** Drops a pending hold (resolved with deny, or granted) and spends its token. */
  dropHold(eventId: string): void {
    this.st.dropHold.run({ eventId });
    this.st.useToken.run({ eventId, now: this.now() });
  }

  /** A human allowed held event `eventId`: records its precedent once; null if not held. */
  grant(eventId: string, by: string): Precedent | null {
    const held = this.pendingHold(eventId);
    if (held === null) return null;
    const precedent: Precedent = {
      key: scopeKey(held.scope),
      sessionId: held.sessionId,
      scope: held.scope,
      riskDelta: PRECEDENT_RISK_DELTA,
      grantedAt: this.now(),
      expiresAt: null,
      policies: held.policies,
      eventId,
      by,
    };
    this.db.transaction(() => {
      this.insert(precedent);
      this.dropHold(eventId);
    })();
    return precedent;
  }

  /** Stores a precedent as given (replay rebuilds recorded grants with this). */
  insert(p: Precedent): void {
    this.st.insert.run({
      key: p.key,
      sid: p.sessionId,
      scope: JSON.stringify(p.scope),
      delta: Math.min(PRECEDENT_RISK_DELTA, Math.max(0, p.riskDelta)),
      granted: p.grantedAt,
      expires: p.expiresAt,
      policies: JSON.stringify(p.policies),
      eventId: p.eventId,
      by: p.by,
    });
  }

  /** Precedents of `sessionId`'s root that are still valid now, newest first. */
  active(sessionId: string): Precedent[] {
    const now = this.now();
    const rows = this.st.active.all({
      sid: this.rootOf(sessionId),
      oldest: now - PRECEDENT_MAX_AGE_MS,
      now,
    }) as PrecedentRow[];
    return rows.map(toPrecedent);
  }

  /** The narrowest valid precedent matching `e`; ties go to the most recent grant. */
  lookup(e: PolicyEvent, _ctx: PolicyContext): PrecedentMatch | null {
    const task = taskHash(e.session.task);
    let best: { p: Precedent; score: number } | null = null;
    for (const p of this.active(e.session.id)) {
      const score = matchScore(p.scope, e, task);
      if (score >= 0 && (best === null || score > best.score)) best = { p, score };
    }
    if (best === null) return null;
    return { key: best.p.key, riskDelta: best.p.riskDelta, policies: [...best.p.policies] };
  }

  /** Ends every open precedent of a closed session; returns how many it ended. */
  expireSession(sessionId: string): number {
    return this.st.expire.run({ sid: this.rootOf(sessionId), now: this.now() }).changes;
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.st)) s.finalize();
    this.db.close();
  }
}
