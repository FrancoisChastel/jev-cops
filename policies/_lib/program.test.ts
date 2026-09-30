import { describe, expect, test } from "bun:test";
import { buildPolicyEvent, WRAPPERS } from "@jev-cops/core";
import { bashPre } from "../../tests/fixtures/context/index.ts";
import { programOf, programsOf, WRAPPER_VERBS } from "./program.ts";

async function programs(command: string): Promise<(string | null)[]> {
  const e = buildPolicyEvent(await bashPre(command), null);
  return e.commands.map(programOf);
}

describe("programOf", () => {
  test.each([
    ["cops explain evt", ["cops"]],
    ["./dist/cops replay a.jsonl", ["cops"]],
    ["sudo -u root cops budget --reset x", ["cops"]],
    ["env X=1 cops explain evt", ["cops"]],
    ["command cops install claude-code", ["cops"]],
    ["timeout 5 nice -n 5 cops explain evt", ["cops"]],
    ["sudo rm -rf ~", ["rm"]],
    ["echo cops explain", ["echo"]],
    ["grep cops README.md", ["grep"]],
    ['git commit -m "cops budget"', ["git"]],
    ['bash -c "cops explain evt"', ["bash", "cops"]],
  ] as const)("%s runs %p", async (command, expected) => {
    expect(await programs(command)).toEqual([...expected]);
  });

  test("a dynamic command name stays verbatim, so it is never a known program", async () => {
    expect(await programs("$X explain")).toEqual(["$X"]);
  });

  test("a wrapper with nothing to run has no program", async () => {
    expect(await programs("sudo -u root")).toEqual([null]);
  });

  test.each([
    ["find . -exec cops explain evt \\;", ["find", "cops"]],
    ["sudo find / -delete -exec env X=1 cops replay a \\;", ["find", "cops"]],
    ["find . -name cops -print", ["find"]],
    ["find . -delete", ["find"]],
    ["sudo cops explain evt", ["cops"]],
    ["echo cops explain", ["echo"]],
    ["$X", ["$X"]],
    ["sudo", []],
  ] as const)("programsOf(%s) is %p", async (command, expected) => {
    const e = buildPolicyEvent(await bashPre(command), null);
    expect(e.commands.flatMap(programsOf)).toEqual([...expected]);
  });

  test("WRAPPER_VERBS are the verbs the normalizer's wrappers add, no more, no less", () => {
    const core = new Set(Object.values(WRAPPERS).flatMap((rule) => rule.verbs));
    expect([...WRAPPER_VERBS].sort()).toEqual([...core].sort());
  });
});
