import type { DurationInput } from "./types.ts";

const SECOND_MS = 1_000;
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  s: SECOND_MS,
  m: 60 * SECOND_MS,
  h: 3_600 * SECOND_MS,
});
const DURATION = /^(\d+(?:\.\d+)?)([smh])$/;

/**
 * Milliseconds for a policy window: a number is taken as ms, a string must be `Ns`,
 * `Nm` or `Nh` with a non-negative decimal N. Throws a RangeError on anything else, so
 * a typo in a policy surfaces as a policy error (which the engine fails toward asking).
 */
export function parseDuration(window: DurationInput): number {
  if (typeof window === "number") {
    if (Number.isFinite(window) && window >= 0) return window;
    throw new RangeError(`duration must be a finite non-negative number, got ${window}`);
  }
  const match = DURATION.exec(window);
  const unit = match?.[2] === undefined ? undefined : UNIT_MS[match[2]];
  if (match === null || unit === undefined) {
    throw new RangeError(`duration must look like 30s, 2m or 1h, got "${window}"`);
  }
  return Number(match[1]) * unit;
}
