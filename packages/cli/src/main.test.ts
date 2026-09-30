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

  test("every command of the usage is available: none is left as a milestone stub", () => {
    expect(CLI_USAGE).not.toContain("not yet available");
  });

  test("doctor is a command, listed in the usage; a usage error exits 2 before any check", async () => {
    expect(CLI_USAGE).toContain("doctor [--harness claude-code|pi|all]");
    const io = captureIo();
    expect(await main(["doctor", "--harness", "codex"], io)).toBe(2);
    expect(io.stderr[0]).toContain("cops doctor: --harness must be one of");
    expect(io.stdout).toEqual([]);
  });

  test("the binary runs as a process", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "--version"], {
      stdout: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect((await new Response(proc.stdout).text()).trim()).toBe("0.0.0");
  });
});
