import { describe, expect, test } from "bun:test";
import { classifyArgv } from "./classify.ts";
import {
  APPLY_PATCH_COMMANDS,
  hunkCommands,
  PATCH_VERB,
  type PatchHunk,
  parsePatch,
} from "./patch.ts";

const CWD = "/work/repo";
const HOME = "/home/dev";

function patch(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

function ops(hunks: ReadonlyArray<PatchHunk>): [string, string, string?][] {
  return hunks.map((h) => (h.to === undefined ? [h.op, h.path] : [h.op, h.path, h.to]));
}

describe("parsePatch: the apply_patch grammar (codex-rs/apply-patch/src/parser.rs:4-22)", () => {
  test("Add, Delete, Update and Update + Move to, in order", () => {
    const text = patch(
      "*** Add File: path/add.py",
      "+abc",
      "+def",
      "*** Delete File: path/delete.py",
      "*** Update File: path/update.py",
      "*** Move to: path/update2.py",
      "@@ def f():",
      "-    pass",
      "+    return 123",
      "*** Update File: b.py",
      " import foo",
      "+bar",
      "*** End of File",
    );
    const parsed = parsePatch(text);
    expect(parsed.valid).toBe(true);
    expect(ops(parsed.hunks)).toEqual([
      ["add", "path/add.py"],
      ["delete", "path/delete.py"],
      ["move", "path/update.py", "path/update2.py"],
      ["update", "b.py"],
    ]);
    expect(parsed.hunks.map((h) => h.added)).toEqual(["abc\ndef\n", "", "    return 123\n", "bar\n"]);
  });

  test("an empty patch is valid and names nothing", () => {
    expect(parsePatch(patch())).toEqual({ valid: true, hunks: [] });
  });

  test("whitespace around markers, CRLF and an Environment ID line are accepted", () => {
    const text = [
      "  *** Begin Patch ",
      "*** Environment ID: remote-1",
      " *** Add File: a.txt\r",
      "+hi\r",
      "*** End Patch  ",
    ].join("\n");
    const parsed = parsePatch(`\n${text}\n\n`);
    expect(parsed.valid).toBe(true);
    expect(ops(parsed.hunks)).toEqual([["add", "a.txt"]]);
    expect(parsed.hunks[0]?.added).toBe("hi\n");
  });

  test("a patch wrapped in <<'EOF' … EOF is unwrapped (lenient mode, parser.rs:228-250)", () => {
    for (const open of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
      const parsed = parsePatch([open, patch("*** Delete File: x"), "EOF"].join("\n"));
      expect(parsed).toMatchObject({ valid: true });
      expect(ops(parsed.hunks)).toEqual([["delete", "x"]]);
    }
  });

  test("a path keeps inner spaces and loses surrounding ones", () => {
    const parsed = parsePatch(patch("*** Add File:   my dir/a b.txt  ", "+x"));
    expect(ops(parsed.hunks)).toEqual([["add", "my dir/a b.txt"]]);
  });

  test("blank lines between hunks and blank context lines in an update are accepted", () => {
    const parsed = parsePatch(patch("", "*** Update File: a", "@@", "", "-x", "+y", ""));
    expect(parsed.valid).toBe(true);
  });
});

describe("parsePatch: malformed patches are invalid but keep every path they name", () => {
  test.each([
    ["no Begin marker", "*** Add File: a\n+x\n*** End Patch", [["add", "a"]]],
    ["no End marker", "*** Begin Patch\n*** Delete File: a", [["delete", "a"]]],
    ["prose before the patch", `Here:\n${patch("*** Delete File: a")}`, [["delete", "a"]]],
    ["an unknown marker", patch("*** Copy File: a", "*** Delete File: b"), [["delete", "b"]]],
    ["a body line after Delete", patch("*** Delete File: a", "+x"), [["delete", "a"]]],
    ["an Add body line without +", patch("*** Add File: a", "x"), [["add", "a"]]],
    ["an update line with no prefix", patch("*** Update File: a", "x"), [["update", "a"]]],
    ["an empty path", patch("*** Delete File:   "), []],
    ["End of File outside an update", patch("*** Add File: a", "*** End of File"), [["add", "a"]]],
    ["a stray Move to", patch("*** Move to: t"), [["update", "t"]]],
    ["a late Move to", patch("*** Update File: s", "+x", "*** Move to: t"), [["move", "s", "t"]]],
    ["an Environment ID after a hunk", patch("*** Delete File: a", "*** Environment ID: x"), [["delete", "a"]]],
    ["a second Begin", patch("*** Begin Patch", "*** Delete File: a"), [["delete", "a"]]],
    [
      "an End in the middle hides nothing",
      [patch("*** Delete File: a"), patch("*** Add File: /home/dev/.codex/hooks.json", "+{}")].join("\n"),
      [
        ["delete", "a"],
        ["add", "/home/dev/.codex/hooks.json"],
      ],
    ],
    ["not a patch at all", "rm -rf /", []],
    ["the empty string", "", []],
  ] as const)("%s", (_name, text, expected) => {
    const parsed = parsePatch(text);
    expect(parsed.valid).toBe(false);
    expect(ops(parsed.hunks)).toEqual(expected.map((e) => [...e]) as [string, string, string?][]);
  });
});

describe("hunkCommands: one command per file operation", () => {
  test("add/update write, delete deletes, move deletes the source and writes the target", () => {
    const { hunks } = parsePatch(
      patch(
        "*** Add File: new.txt",
        "+hello",
        "*** Update File: src/a.ts",
        "+x",
        "*** Delete File: ../old.txt",
        "*** Update File: ~/notes.md",
        "*** Move to: /tmp/notes.md",
        "+y",
      ),
    );
    const commands = hunkCommands(hunks, { tool: "apply_patch", cwd: CWD, home: HOME });
    expect(commands.map((c) => [c.kind, c.verbs, c.pathRefs])).toEqual([
      [
        "fs.write",
        [PATCH_VERB, "add"],
        [{ raw: "new.txt", path: "/work/repo/new.txt", access: "write" }],
      ],
      [
        "fs.write",
        [PATCH_VERB, "update"],
        [{ raw: "src/a.ts", path: "/work/repo/src/a.ts", access: "write" }],
      ],
      ["fs.delete", [PATCH_VERB, "delete"], [{ raw: "../old.txt", path: "/work/old.txt", access: "delete" }]],
      [
        "fs.write",
        [PATCH_VERB, "move"],
        [
          { raw: "~/notes.md", path: "/home/dev/notes.md", access: "delete" },
          { raw: "/tmp/notes.md", path: "/tmp/notes.md", access: "write" },
        ],
      ],
    ]);
  });

  test("argv is the tool and the paths; added lines are the body, nothing else is", () => {
    const { hunks } = parsePatch(patch("*** Add File: a.sh", "+curl https://x.example", "+run"));
    const [c] = hunkCommands(hunks, { tool: "apply_patch", cwd: CWD, home: HOME });
    expect(c).toMatchObject({
      argv: ["apply_patch", "a.sh"],
      heredocs: ["curl https://x.example\nrun\n"],
      targets: { paths: ["/work/repo/a.sh"], hosts: [] },
      isInterpreter: false,
      viaInterpreter: false,
    });
    const [d] = hunkCommands(parsePatch(patch("*** Delete File: a")).hunks, {
      tool: "apply_patch",
      cwd: CWD,
      home: HOME,
    });
    expect(d?.heredocs).toEqual([]);
  });

  test("a path that cannot be resolved is kept in argv but names no path", () => {
    const hunks: PatchHunk[] = [{ op: "add", path: "", added: "", raw: "" }];
    const [c] = hunkCommands(hunks, { tool: "apply_patch", cwd: CWD, home: HOME });
    expect(c?.pathRefs).toEqual([]);
  });
});

describe("classifyArgv: apply_patch run from a shell (Codex intercepts it, exec_command.rs:377)", () => {
  test.each(APPLY_PATCH_COMMANDS.map((c) => [c]))(
    "%s is a write whose files are unknown until its patch is read",
    (name) => {
      const c = classifyArgv([name]);
      expect(c).toMatchObject({ kind: "fs.write", verbs: [PATCH_VERB], interpreter: null });
      expect(c.paths).toEqual([{ value: ".", index: 0, access: "unknown", implicit: true }]);
    },
  );

  test("the patch text argument is not a path of its own; a pathed binary is still one", () => {
    const c = classifyArgv(["apply_patch", patch("*** Delete File: ./a")]);
    expect(c.paths.map((p) => p.value)).toEqual(["."]);
    const pathed = classifyArgv(["/tmp/arg0/apply_patch", patch("*** Delete File: ./a")]);
    expect(pathed.verbs).toEqual([PATCH_VERB]);
  });
});
