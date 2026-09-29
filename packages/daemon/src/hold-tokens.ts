import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@jevdict/core";

/**
 * Hold tokens (T7/T8): the capability `POST /v1/resolve` requires. The daemon mints one
 * for every `hold` it returns to a harness that will ask a human, hands the raw token to
 * the adapter in the verdict response, and keeps only its SHA-256. The agent sees the
 * verdict's `reason` only, so a process that talks to the socket directly cannot approve
 * a hold it did not receive.
 */

/** Random bytes per token (256 bits: not guessable, not brute-forceable). */
export const HOLD_TOKEN_BYTES = 32;
/** Default life of a token: how long the human has to answer (`daemon.hold_token_ttl_ms`). */
export const DEFAULT_HOLD_TOKEN_TTL_MS = 10 * 60_000;
/** How much of a token's hash the audit log may show. */
export const HOLD_TOKEN_HASH_PREFIX = 12;

/** A freshly minted token and the hash the daemon stores in its place. */
export interface MintedHoldToken {
  /** base64url, no padding; handed to the adapter once, never stored or logged. */
  readonly token: string;
  /** Lower-case hex SHA-256 of `token`. */
  readonly hash: string;
}

/** SHA-256 (hex) of a presented token; only hashes are ever compared or stored. */
export function hashHoldToken(token: string): string {
  return sha256Hex(token);
}

/** A new random token and its hash. */
export function mintHoldToken(): MintedHoldToken {
  const token = randomBytes(HOLD_TOKEN_BYTES).toString("base64url");
  return { token, hash: hashHoldToken(token) };
}

/** Constant-time equality of two hex hashes; false when either is empty or lengths differ. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
