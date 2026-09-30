import { describe, expect, test } from "bun:test";
import * as core from "../index.ts";
import * as harness from "./harness.ts";
import * as normalizer from "./index.ts";
import * as normalize from "./normalize.ts";
import * as patch from "./patch.ts";
import * as tools from "./tools.ts";

describe("normalizer public API", () => {
  test("exposes normalize, normalizeCommand and the classification tables", () => {
    expect(typeof normalizer.normalize).toBe("function");
    expect(typeof normalizer.normalizeCommand).toBe("function");
    expect(typeof normalizer.classifyArgv).toBe("function");
    expect(normalizer.VERB_KINDS.rm).toBe("fs.delete");
    expect(normalizer.OPAQUE_REASONS).toContain("decoded-pipe");
  });

  test("exposes the harness tool tables, the patch reader and the M3 verbs", () => {
    expect(normalizer.HARNESS_TOOL_RULES).toBe(tools.HARNESS_TOOL_RULES);
    expect(normalizer.HARNESS_TOOL_ALIASES).toBe(tools.HARNESS_TOOL_ALIASES);
    expect(normalizer.eventToolRule).toBe(normalize.eventToolRule);
    expect(normalizer.mcpServer).toBe(tools.mcpServer);
    expect(normalizer.INTERACTIVE_SHELL_VERB).toBe("interactive-shell");
    expect(normalizer.REPLS).toContain("irb");
    expect(normalizer.PATCH_VERB).toBe("apply_patch");
    expect(normalizer.APPLY_PATCH_COMMANDS).toEqual(["apply_patch", "applypatch"]);
    expect(normalizer.parsePatch).toBe(patch.parsePatch);
    expect(normalizer.withHarnessEnv).toBe(harness.withHarnessEnv);
    expect(normalizer.parsePatch("*** Begin Patch\n*** Delete File: a\n*** End Patch")).toEqual({
      valid: true,
      hunks: [{ op: "delete", path: "a", added: "", raw: "*** Delete File: a" }],
    });
  });

  test("is re-exported from @jev-cops/core", () => {
    expect(core.normalize).toBe(normalizer.normalize);
    expect(core.normalizeCommand).toBe(normalizer.normalizeCommand);
    expect(core.HARNESS_TOOL_RULES).toBe(normalizer.HARNESS_TOOL_RULES);
    expect(core.parsePatch).toBe(normalizer.parsePatch);
    expect(core.INTERACTIVE_SHELL_VERB).toBe(normalizer.INTERACTIVE_SHELL_VERB);
  });
});
