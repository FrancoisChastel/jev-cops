/**
 * T8 — Social engineering the human (spec §Threat model).
 *
 * Attack: Agent's stated reason misdescribes the command
 * Required outcome: Confirm prompt shows the normalized raw command and the daemon's `detail`, never the agent's text
 *
 * Status: todo. Milestone: M1 (hold-to-ask mapping in the Claude Code adapter).
 */
import { describe, test } from "bun:test";
import { pending } from "./pending.ts";

const REQUIRED_OUTCOME =
  "Confirm prompt shows the normalized raw command and the daemon's `detail`, never the agent's text";

describe("T8 social engineering the human", () => {
  test.todo(REQUIRED_OUTCOME, pending("M1 (hold-to-ask mapping in the Claude Code adapter)"));
});
