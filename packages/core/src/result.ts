/**
 * Outcome of an operation that can fail on untrusted input. Parsers and other
 * boundary functions return this instead of throwing, so a caller cannot forget
 * the failure branch and an adapter can always fail closed.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Builds the success branch of a {@link Result}. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Builds the failure branch of a {@link Result}. */
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
