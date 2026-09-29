import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { captureIo, EXIT, PROCESS_IO } from "./io.ts";

afterEach(() => {
  for (const stream of [process.stdout, process.stderr]) {
    (stream.write as unknown as { mockRestore?: () => void }).mockRestore?.();
  }
});

describe("PROCESS_IO", () => {
  test("writes one line per call: out to stdout, err to stderr", () => {
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    PROCESS_IO.out("a verdict");
    PROCESS_IO.err("a warning");
    expect(out.mock.calls).toEqual([["a verdict\n"]]);
    expect(err.mock.calls).toEqual([["a warning\n"]]);
    expect(Object.isFrozen(PROCESS_IO)).toBe(true);
  });
});

describe("captureIo", () => {
  test("records lines without writing anywhere", () => {
    const out = spyOn(process.stdout, "write");
    const io = captureIo();
    io.out("x");
    io.err("y");
    expect({ stdout: io.stdout, stderr: io.stderr }).toEqual({ stdout: ["x"], stderr: ["y"] });
    expect(out).not.toHaveBeenCalled();
  });

  test("exit codes are 0 ok, 1 failed, 2 usage", () => {
    expect(EXIT).toEqual({ ok: 0, failed: 1, usage: 2 });
  });
});
