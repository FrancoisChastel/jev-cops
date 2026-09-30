import { describe, expect, test } from "bun:test";
import { commandHelp, wantsHelp } from "./help.ts";
import { captureIo } from "./io.ts";
import { CLI_USAGE, COMMANDS, main } from "./main.ts";

const NAMES = Object.keys(COMMANDS);

describe("cops <command> --help", () => {
  test("every command has its own help: its usage entries and its exit codes", () => {
    for (const name of NAMES) {
      const help = commandHelp(name, CLI_USAGE);
      expect(help, name).not.toBeNull();
      expect(help ?? "", name).toContain(`  ${name}`);
      expect(help ?? "", name).toContain("Exit codes:");
      if (name !== "hook") {
        expect(help ?? "", name).not.toContain("the Claude Code command hook: reads the hook");
      }
    }
  });

  test("a command's help holds every one of its entries and no other command's", () => {
    const install = commandHelp("install", CLI_USAGE) ?? "";
    expect(install).toContain("install claude-code");
    expect(install).toContain("install pi");
    expect(install).toContain("install: 0 installed");
    expect(install).not.toContain("  doctor [--harness");
    expect(install).not.toContain("openshell:");
  });

  test("an unknown command has no help", () => {
    expect(commandHelp("frob", CLI_USAGE)).toBeNull();
  });

  test.each(NAMES.filter((n) => n !== "hook"))(
    "cops %s --help and -h print the help on stdout, exit 0 and run nothing",
    async (name) => {
      for (const flag of ["--help", "-h"]) {
        const io = captureIo();
        expect(await main([name, flag], io)).toBe(0);
        expect(io.stdout.join("\n")).toBe(commandHelp(name, CLI_USAGE) ?? "");
        expect(io.stderr).toEqual([]);
      }
    },
  );

  test("the flag works after other arguments too", async () => {
    const io = captureIo();
    expect(await main(["explain", "evt_x", "--help"], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("  explain <event-id>");
  });

  test("cops help <command> prints the same help; cops help frob exits 2", async () => {
    const io = captureIo();
    expect(await main(["help", "doctor"], io)).toBe(0);
    expect(io.stdout.join("\n")).toBe(commandHelp("doctor", CLI_USAGE) ?? "");
    const bad = captureIo();
    expect(await main(["help", "frob"], bad)).toBe(2);
    expect(bad.stderr.join("\n")).toContain('unknown command "frob"');
  });

  test("cops hook --help never exits 0: the hook's 0 means proceed, so help goes to stderr with exit 2", async () => {
    const io = captureIo();
    expect(await main(["hook", "--help"], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("\n")).toContain("  hook --harness claude-code");
  });

  test("wantsHelp matches only the exact flags", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["x", "-h"])).toBe(true);
    expect(wantsHelp(["--helpful", "-hh", "help"])).toBe(false);
  });
});
