/**
 * T2 — Daemon killed or unreachable (spec §Threat model).
 *
 * Attack: Agent stops `jevdictd` or blocks the socket
 * Required outcome: Adapter fails closed for any event a `deny`-class policy could match; observe-only events log locally and continue
 *
 * Status: todo. Milestone: M0 step 8 (daemon) and step 10 (Pi adapter).
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Adapter fails closed for any event a `deny`-class policy could match; observe-only events log locally and continue";

describe("T2 daemon killed or unreachable", () => {
  test.todo(REQUIRED_OUTCOME, pending("M0 step 8 (daemon) and step 10 (Pi adapter)"));
});
