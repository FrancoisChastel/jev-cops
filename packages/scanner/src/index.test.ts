import { describe, expect, test } from "bun:test";
import { createScanner, NO_SCANNER, SCAN_SCHEMA, type ScannerConfig } from "./index.ts";

const NOTHING_ON_PATH = { PATH: "/nonexistent-jev-cops-bin" };
const TARGET = { kind: "dir", path: "/" } as const;

describe("createScanner", () => {
  test("builds each adapter by name; never throws", () => {
    const configs: ScannerConfig[] = [
      { adapter: "none" },
      { adapter: "skillspector" },
      { adapter: "skillspector", binary: "relative", extraArgs: ["--nope"] },
      { adapter: "command", argv: [] },
    ];
    expect(configs.map((c) => createScanner(c, { env: NOTHING_ON_PATH }).name)).toEqual([
      "none",
      "skillspector",
      "skillspector",
      "command",
    ]);
  });

  test("skillspector missing: available() says so; scan() is an error (the gate holds)", async () => {
    const s = createScanner({ adapter: "skillspector" }, { env: NOTHING_ON_PATH });
    expect(await s.available()).toEqual({ ok: false, reason: "skillspector not found on PATH" });
    expect(await s.scan(TARGET, { deadlineMs: 1_000 })).toMatchObject({
      verdict: "error",
      error: "skillspector not found on PATH",
      tool: "skillspector",
      mode: "static",
      network: "none",
    });
  });

  test("none is available and its scan is an error, never safe", async () => {
    const s = createScanner({ adapter: "none" });
    expect(await s.available()).toEqual({ ok: true, version: null });
    expect((await s.scan(TARGET, { deadlineMs: 1_000 })).error).toBe(NO_SCANNER);
  });

  test("an unknown adapter (an unchecked config) never passes for none", async () => {
    const s = createScanner({ adapter: "clamav" } as unknown as ScannerConfig);
    expect(s.name).not.toBe("none");
    expect(await s.available()).toEqual({ ok: false, reason: "unknown scanner adapter: clamav" });
    expect((await s.scan(TARGET, { deadlineMs: 1_000 })).verdict).toBe("error");
  });

  test("the command contract's schema name", () => {
    expect(SCAN_SCHEMA).toBe("jev-cops.scan/1");
  });
});
