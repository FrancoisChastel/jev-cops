import type { CaseFile, Harness, Judgement, PreEvent, VerdictResponse } from "@jevdict/core";
import type { Runtime } from "./daemon.ts";
import { HOLD_TOKEN_HASH_PREFIX, mintHoldToken } from "./hold-tokens.ts";
import { proposeScope } from "./precedents.ts";

/**
 * The response header that carries a view-only token (lower case, as `Headers` reports
 * it): it unlocks the T8 confirm view of a hold nothing can resolve.
 */
export const VIEW_TOKEN_HEADER = "x-jevdict-view-token";

/**
 * Harnesses whose own UI answers a `hold` without jevdict learning the answer, so no
 * precedent can come from their holds (D-069 proposal): Claude Code's `ask` prompt.
 */
export const NO_PRECEDENT_HARNESSES: ReadonlySet<Harness> = new Set<Harness>(["claude-code"]);

/**
 * A token issued for a hold. `hold`: the single-use capability `/v1/resolve` takes
 * (D-059), returned as `hold_token`. `view`: unlocks the confirm view only, returned in
 * {@link VIEW_TOKEN_HEADER}; no pending hold exists, so `/v1/resolve` refuses it.
 */
export interface IssuedToken {
  readonly kind: "hold" | "view";
  /** base64url; handed to the adapter once, never stored or logged. */
  readonly token: string;
  /** Hex SHA-256 of `token`. */
  readonly hash: string;
}

/** `name@version` → `name`: core waives a precedent's policies by name. */
function policyName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Records a hold the harness will show a human: the T8 confirm view (daemon memory only)
 * and a fresh token that unlocks it, valid for `daemon.hold_token_ttl_ms`. For a harness
 * that reports the human's answer (Pi), also the pending hold with the daemon's proposed
 * precedent scope and the token's hash, so `/v1/resolve` can redeem it once. For
 * {@link NO_PRECEDENT_HARNESSES} the token is view-only.
 */
export function recordHold(
  rt: Runtime,
  event: PreEvent,
  cf: CaseFile,
  j: Judgement,
  reason: string,
): IssuedToken {
  const minted = mintHoldToken();
  const expiresAt = rt.now() + rt.config.daemon.holdTokenTtlMs;
  const view = { event_id: event.id, verdict: "hold", reason, raw: j.normalized.raw } as const;
  const full = { ...view, detail: j.decision.detail };
  if (NO_PRECEDENT_HARNESSES.has(event.harness)) {
    rt.confirmViews.put(full, expiresAt, minted.hash);
    return { kind: "view", ...minted };
  }
  rt.precedents.recordHold(
    {
      eventId: event.id,
      sessionId: event.session.id,
      scope: proposeScope(j.normalized, cf.task),
      policies: j.decision.policies.map(policyName),
    },
    { hash: minted.hash, expiresAt },
  );
  rt.confirmViews.put(full, expiresAt);
  return { kind: "hold", ...minted };
}

/** The audit's record of an issued token: a hash prefix under its kind, never the token. */
export function tokenTrace(token: IssuedToken | null): Record<string, string> {
  if (token === null) return {};
  const prefix = token.hash.slice(0, HOLD_TOKEN_HASH_PREFIX);
  return token.kind === "hold" ? { hold_token_sha256: prefix } : { view_token_sha256: prefix };
}

/** Body and headers of a verdict with its token: `hold_token` in the body, or the header. */
export function deliver(
  response: VerdictResponse,
  token: IssuedToken | null,
): { body: unknown; headers?: Readonly<Record<string, string>> } {
  if (token === null) return { body: response };
  if (token.kind === "hold") return { body: { ...response, hold_token: token.token } };
  return { body: response, headers: { [VIEW_TOKEN_HEADER]: token.token } };
}
