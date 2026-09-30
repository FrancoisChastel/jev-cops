import { describe, expect, test } from "bun:test";
import { CORE_VERSION } from "./index.ts";

describe("@jev-cops/core", () => {
  test("exposes a version string", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
