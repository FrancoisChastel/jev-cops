/**
 * T12 — Log tampering (spec §Threat model).
 *
 * Attack: Agent edits or truncates the audit log
 * Required outcome: Log is append-only, hash-chained, and shipped off-box; a chain break is an alert
 *
 * Status: todo. Milestone: M0 step 8 (JSONL audit chain); M2 (chain verified by jevdict doctor).
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Log is append-only, hash-chained, and shipped off-box; a chain break is an alert";

describe("T12 log tampering", () => {
  test.todo(
    REQUIRED_OUTCOME,
    pending("M0 step 8 (JSONL audit chain); M2 (chain verified by jevdict doctor)"),
  );
});
