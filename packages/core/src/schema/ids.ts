import { ulid } from "ulid";
import { z } from "zod";

/**
 * Canonical ULID: 26 upper-case Crockford base32 characters (no I, L, O, U), with a
 * first character of at most 7 so the 48-bit timestamp cannot overflow.
 */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Prefix of every event id. */
export const EVENT_ID_PREFIX = "evt_";
/** Prefix of every session id, including `session.parent_id`. */
export const SESSION_ID_PREFIX = "sess_";
/** Prefix of every call id. */
export const CALL_ID_PREFIX = "call_";

/** True when `value` is a canonical ULID as minted by {@link mintEventId}. */
export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function prefixedId(prefix: string): z.ZodString {
  return z
    .string()
    .regex(new RegExp(`^${prefix}\\S+$`), `must be "${prefix}" followed by a non-empty id`);
}

/** Event id: `evt_` + ULID. Minted once by the adapter; keys the verdict and audit log. */
export const eventIdSchema = z
  .string()
  .refine(
    (value) => value.startsWith(EVENT_ID_PREFIX) && isUlid(value.slice(EVENT_ID_PREFIX.length)),
    `must be "${EVENT_ID_PREFIX}" followed by a 26-char ULID`,
  );

/** Session id: `sess_` + a non-empty, whitespace-free id, stable for the whole run. */
export const sessionIdSchema = prefixedId(SESSION_ID_PREFIX);

/** Call id: `call_` + the harness tool-call id; pairs a pre event with its post event. */
export const callIdSchema = prefixedId(CALL_ID_PREFIX);

/** Mints a fresh event id (`evt_` + ULID) for an adapter to stamp on a new event. */
export function mintEventId(): string {
  return `${EVENT_ID_PREFIX}${ulid()}`;
}
