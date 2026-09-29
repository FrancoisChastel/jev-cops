import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SILENT_LOGGER, stderrLogger } from "./log.ts";

afterEach(() => {
  (process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function captureStderr(): string[] {
  const lines: string[] = [];
  spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe("stderrLogger", () => {
  test("writes one JSON object per line with the time, level, message and fields", () => {
    const lines = captureStderr();
    stderrLogger(() => Date.UTC(2026, 8, 29, 9, 12)).log("warn", "policy reload rejected", {
      problems: ["a.ts: bad"],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      at: "2026-09-29T09:12:00.000Z",
      level: "warn",
      msg: "policy reload rejected",
      problems: ["a.ts: bad"],
    });
  });

  test("fields are optional and never on stdout", () => {
    const lines = captureStderr();
    const stdout = spyOn(process.stdout, "write");
    stderrLogger().log("info", "listening");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", msg: "listening" });
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
  });
});

describe("debug lines", () => {
  test("are dropped unless debug is on", () => {
    const lines = captureStderr();
    stderrLogger().log("debug", "env.git not derived", { why: "timeout" });
    expect(lines).toEqual([]);
    stderrLogger(Date.now, { debug: true }).log("debug", "env.git not derived");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "debug" });
  });
});

describe("SILENT_LOGGER", () => {
  test("drops everything", () => {
    const lines = captureStderr();
    SILENT_LOGGER.log("error", "boom", { x: 1 });
    expect(lines).toEqual([]);
    expect(Object.isFrozen(SILENT_LOGGER)).toBe(true);
  });
});
