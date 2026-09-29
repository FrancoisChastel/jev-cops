/**
 * T3 — Hook timeout (spec §Threat model).
 *
 * Attack: Daemon sleeps 15 seconds on one event
 * Required outcome: Adapter returns `deny` with reason "judge timeout", never allow-by-timeout
 *
 * Status: todo. Milestone: M0 step 8 (daemon) and step 10 (Pi adapter).
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  'Adapter returns `deny` with reason "judge timeout", never allow-by-timeout';

describe("T3 hook timeout", () => {
  test.todo(REQUIRED_OUTCOME, pending("M0 step 8 (daemon) and step 10 (Pi adapter)"));
});
