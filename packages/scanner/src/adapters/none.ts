/**
 * No scanner configured. `available()` is ok (nothing is missing), and the daemon's gate never
 * calls `scan()`: it reports `status: "none"`, which the `skill-install` policy maps to
 * `annotate`, never to a false `safe` (PLAN-SETUP §8 row 14). Called anyway, `scan()`
 * answers `error`, so a caller that forgets the check still fails closed.
 */
import type { Scanner } from "../types.ts";
import { errorResult, type ResultBase } from "./shared.ts";

/** The error `none` answers if `scan()` is called. */
export const NO_SCANNER = "no scanner configured";

const BASE: ResultBase = { tool: "none", mode: "static", network: "none", version: null };

/** The `none` scanner. */
export function createNoneScanner(): Scanner {
  return {
    name: "none",
    available: async () => ({ ok: true, version: null }),
    scan: async () => errorResult(BASE, NO_SCANNER, performance.now()),
  };
}
