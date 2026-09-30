import { describe, expect, test } from "bun:test";
import { failsOpen } from "./tools.ts";

describe("failsOpen: which Claude Code tools run while the daemon is down", () => {
  test.each(["Read", "Glob", "Grep", "TodoWrite", "ExitPlanMode", "TaskList"])(
    "%s proceeds with a warning",
    (tool) => {
      expect(failsOpen(tool)).toBe(true);
    },
  );

  test.each([
    ...["Bash", "Write", "Edit", "Task", "WebFetch", "EnterWorktree", "mcp__fs__read"],
    // Another harness's bookkeeping or read names are unknown tools on Claude Code.
    ...["todowrite", "update_plan", "wait_agent", "question", "read", "view_image"],
  ])("%s fails closed", (tool) => {
    expect(failsOpen(tool)).toBe(false);
  });
});
