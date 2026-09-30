import type { Runtime } from "./daemon.ts";
import { hashHoldToken, sameHash } from "./hold-tokens.ts";
import type { Redeemed, RedeemFailure } from "./precedents.ts";
import type { Reply } from "./service.ts";

/**
 * The T8 confirm view: what an adapter shows the human for a pending `hold` (spec: "the
 * normalized raw command and the daemon's `detail`, never the agent's text"). It is the
 * only explain served on agent channels (the agent socket and loopback HTTP), and only to
 * a caller holding that hold's token; the full audit line is on the admin socket.
 */
export interface ConfirmView {
  readonly event_id: string;
  readonly verdict: "hold";
  /** The harness-facing reason (the one the agent already saw). */
  readonly reason: string;
  /** The daemon's normalized raw command. */
  readonly raw: string;
  /** The human paragraph of the decision. */
  readonly detail: string;
  /** The decision's confirm summary (`Decision.confirmLines`, one per line): no score. */
  readonly summary: string;
}

/** A view's own token checked: it matched, it did not, or the view has none. */
export type OwnTokenCheck =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly view: ConfirmView }
  | { readonly kind: "refused"; readonly why: "no-token" | "mismatch" };

/** How many pending views are kept; the oldest is dropped past this. */
export const MAX_CONFIRM_VIEWS = 1_024;
/** Longest bearer token accepted (a hold token is 43 characters). */
const MAX_TOKEN_CHARS = 256;

/**
 * Confirm views of pending holds, in the daemon's memory only: nothing the agent can
 * write (the audit file, the SQLite store) feeds what the human is shown. A daemon
 * restart forgets them; the adapter then cannot load the view and blocks without asking.
 */
export class ConfirmViews {
  private readonly views = new Map<
    string,
    { view: ConfirmView; expiresAt: number; tokenHash: string | null }
  >();

  constructor(private readonly max = MAX_CONFIRM_VIEWS) {}

  /**
   * Remembers the view of a hold until its token expires. `tokenHash` is set for a view
   * with its own view-only token (a hold no one can resolve); otherwise the pending hold's
   * token in the precedent store guards it.
   */
  put(view: ConfirmView, expiresAt: number, tokenHash: string | null = null): void {
    this.views.delete(view.event_id);
    this.views.set(view.event_id, { view, expiresAt, tokenHash });
    for (const key of this.views.keys()) {
      if (this.views.size <= this.max) break;
      this.views.delete(key);
    }
  }

  /** The view of `eventId`, or null when unknown or expired at `now`. */
  get(eventId: string, now: number): ConfirmView | null {
    const hit = this.views.get(eventId);
    if (hit === undefined) return null;
    if (hit.expiresAt > now) return hit.view;
    this.views.delete(eventId);
    return null;
  }

  /**
   * Checks `token` against a live view's own token (constant time). `none`: the view has
   * no own token, or is unknown or expired; the pending hold's token decides instead.
   */
  checkOwn(eventId: string, token: string | undefined, now: number): OwnTokenCheck {
    const view = this.get(eventId, now);
    const hash = this.views.get(eventId)?.tokenHash ?? null;
    if (view === null || hash === null) return { kind: "none" };
    if (token === undefined || token === "") return { kind: "refused", why: "no-token" };
    if (!sameHash(hash, hashHoldToken(token))) return { kind: "refused", why: "mismatch" };
    return { kind: "ok", view };
  }

  /** Forgets the view of a resolved hold. */
  delete(eventId: string): void {
    this.views.delete(eventId);
  }
}

/** The token of an `Authorization: Bearer <token>` header; undefined otherwise. */
export function bearerToken(header: string | null): string | undefined {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
  const token = match?.[1];
  return token !== undefined && token.length <= MAX_TOKEN_CHARS ? token : undefined;
}

const NOT_PENDING: Reply = { status: 404, body: { error: "no pending hold with this id" } };
/** Failures that mean "not your hold" (403) rather than "no longer pending" (404). */
const REFUSED: ReadonlySet<RedeemFailure> = new Set(["no-token", "mismatch"]);

/**
 * `GET /v1/explain/:event_id` on agent channels. The caller must present the hold's token
 * as `Authorization: Bearer <token>` (a header, so it never lands in an access log).
 * Missing or wrong token → 403 plus an `anomaly` line (T8: the agent cannot read the
 * human's detail by curling the socket); a hold that is not pending (never held,
 * resolved, expired) → 404. Viewing does not spend the token; resolving does. A view with
 * its own view-only token (a Claude Code hold) is checked against that token instead.
 */
export function handleConfirmView(rt: Runtime, eventId: string, authorization: string | null) {
  const token = bearerToken(authorization);
  const own = rt.confirmViews.checkOwn(eventId, token, rt.now());
  if (own.kind === "ok") return { status: 200, body: own.view } satisfies Reply;
  const checked: Redeemed =
    own.kind === "refused" ? { ok: false, why: own.why } : rt.precedents.check(eventId, token);
  if (!checked.ok && REFUSED.has(checked.why)) {
    rt.audit.append({
      kind: "anomaly",
      event_id: eventId,
      payload: { reason: "explain-without-valid-token", why: checked.why },
    });
    return { status: 403, body: { error: "invalid hold token" } } satisfies Reply;
  }
  const view = checked.ok ? rt.confirmViews.get(eventId, rt.now()) : null;
  return view === null ? NOT_PENDING : ({ status: 200, body: view } satisfies Reply);
}
