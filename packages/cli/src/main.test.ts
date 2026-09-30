import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { captureIo } from "./io.ts";
import { CLI_USAGE, main } from "./main.ts";

describe("jev-cops", () => {
  test("--help prints the usage with the exit codes", async () => {
    const io = captureIo();
    expect(await main(["--help"], io)).toBe(0);
    expect(io.stdout.join("\n")).toBe(CLI_USAGE);
    expect(CLI_USAGE).toContain("Exit codes:");
  });

  test("no command prints usage and exits 2", async () => {
    expect(await main([], captureIo())).toBe(2);
  });

  test("an unknown command exits 2", async () => {
    const io = captureIo();
    expect(await main(["frob"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain('unknown command "frob"');
  });

  test("hook is a command, listed in the usage", () => {
    expect(CLI_USAGE).toContain("hook --harness claude-code");
  });

  test.each(["install", "doctor"])("%s is not yet available (M1) and exits 2", async (name) => {
    const io = captureIo();
    expect(await main([name], io)).toBe(2);
    expect(io.stderr).toEqual([`jev-cops ${name}: not yet available (M1)`]);
  });

  test("the binary runs as a process", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "--version"], {
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect((await new Response(proc.stdout).text()).trim()).toBe("0.0.0");
  });
});
