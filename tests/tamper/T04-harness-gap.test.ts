/**
 * T4 — Harness gap (spec §Threat model).
 *
 * Attack: Subagent in OpenCode; `unified_exec` in Codex; `permissions.allow` in Claude Code
 * Required outcome: Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated
 *
 * Status: todo. Milestone: M2 (OpenShell compiler); M1/M3 installers for Claude Code, Codex, OpenCode.
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Compiled OpenShell fragment blocks the same action; installer warns when the gap is present and unmitigated";

describe("T4 harness gap", () => {
  test.todo(
    REQUIRED_OUTCOME,
    pending("M2 (OpenShell compiler); M1/M3 installers for Claude Code, Codex, OpenCode"),
  );
});
