import { describe, expect, test } from "bun:test";
import * as core from "../index.ts";
import * as normalizer from "./index.ts";

describe("normalizer public API", () => {
  test("exposes normalize, normalizeCommand and the classification tables", () => {
    expect(typeof normalizer.normalize).toBe("function");
    expect(typeof normalizer.normalizeCommand).toBe("function");
    expect(typeof normalizer.classifyArgv).toBe("function");
    expect(normalizer.VERB_KINDS.rm).toBe("fs.delete");
    expect(normalizer.OPAQUE_REASONS).toContain("decoded-pipe");
  });

  test("is re-exported from @jev-cops/core", () => {
    expect(core.normalize).toBe(normalizer.normalize);
    expect(core.normalizeCommand).toBe(normalizer.normalizeCommand);
  });
});
