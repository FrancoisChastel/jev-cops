import { describe, expect, test } from "bun:test";
import { loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import { openCodeBeforeFixtures } from "../../../../tests/fixtures/opencode/index.ts";
import { type Event, type Harness, parseEvent } from "../schema/event.ts";
import { INTERACTIVE_SHELL_VERB } from "./interpreters.ts";
import { normalize } from "./normalize.ts";
import { PATCH_VERB } from "./patch.ts";
import type { NormalizedEvent, PathAccess } from "./types.ts";

const HOME = "/home/dev";
const OPTS = { home: HOME };

type Json = Record<string, unknown>;

function event(harness: Harness, tool: string, input: Json, cwd = "/work/repo"): Event {
  const base = loadEventFixture("pre-bash") as Json;
  const call = { ...(base.call as Json), tool, kind: "other", input, cwd };
  const parsed = parseEvent({ ...base, harness, harness_version: "1.18.33", call });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const opencode = (tool: string, input: Json): Event => event("opencode", tool, input);

/** A documented `tool.execute.before` call as the plugin will send it (tool, args, directory). */
function fromFixture(name: string): Event {
  const fixtures = openCodeBeforeFixtures();
  const call = fixtures.before[name];
  if (call === undefined) throw new Error(`no fixture ${name}`);
  return event("opencode", call.input.tool, call.output.args, fixtures.directory);
}

function access(n: NormalizedEvent): Record<string, PathAccess> {
  return Object.fromEntries(n.commands.flatMap((c) => c.pathRefs.map((r) => [r.path, r.access])));
}

const verbs = (n: NormalizedEvent): string[] => n.commands.flatMap((c) => c.verbs);

describe("normalize: OpenCode bash (tool/shell/prompt.ts: command, timeout ms, workdir)", () => {
  test("command is parsed like Bash; timeout changes nothing", async () => {
    const n = await normalize(fromFixture("bash"), OPTS);
    expect(n).toMatchObject({
      kind: "fs.delete",
      paths: ["/work/repo/build"],
      raw: "rm -rf ./build",
    });
  });

  test("workdir is the cwd of that call, named like a leading cd", async () => {
    const n = await normalize(
      opencode("bash", { command: "rm -rf build", workdir: "/tmp/w" }),
      OPTS,
    );
    expect(n.kind).toBe("fs.delete");
    expect(access(n)).toEqual({ "/tmp/w": "unknown", "/tmp/w/build": "delete" });
    expect(n.commands[0]).toMatchObject({ argv: ["cd", "/tmp/w"], verbs: ["cd"], kind: "other" });
    expect(n.raw).toBe("rm -rf build");
  });

  test("the fixture's workdir write lands in the OpenCode config dir", async () => {
    const n = await normalize(fromFixture("bash-workdir"), OPTS);
    expect(access(n)).toMatchObject({ [`${HOME}/.config/opencode/opencode.json`]: "write" });
  });

  test.each([
    ["sub", "/work/repo/sub"],
    ["../x", "/work/x"],
    ["~/.config/opencode", `${HOME}/.config/opencode`],
  ])("workdir %s resolves to %s", async (workdir, dir) => {
    const n = await normalize(opencode("bash", { command: "touch a", workdir }), OPTS);
    expect(access(n)).toEqual({ [dir]: "unknown", [`${dir}/a`]: "write" });
  });

  test("an empty or non-string workdir is ignored, as OpenCode does", async () => {
    for (const workdir of ["", 7, null]) {
      const n = await normalize(opencode("bash", { command: "touch a", workdir }), OPTS);
      expect(access(n)).toEqual({ "/work/repo/a": "write" });
    }
  });

  test("the state hash tells two workdirs apart even when no path is relative", async () => {
    const a = await normalize(opencode("bash", { command: "make", workdir: "/a" }), OPTS);
    const b = await normalize(opencode("bash", { command: "make", workdir: "/b" }), OPTS);
    const none = await normalize(opencode("bash", { command: "make" }), OPTS);
    expect(new Set([a.stateHash, b.stateHash, none.stateHash]).size).toBe(3);
  });

  test("a bare REPL carries the interactive-shell verb", async () => {
    const n = await normalize(fromFixture("bash-interactive"), OPTS);
    expect(verbs(n)).toContain(INTERACTIVE_SHELL_VERB);
  });

  test("Pi's bash has no workdir: the field is not read there", async () => {
    const n = await normalize(event("pi", "bash", { command: "touch a", workdir: "/x" }), OPTS);
    expect(access(n)).toEqual({ "/work/repo/a": "write" });
  });
});

describe("normalize: OpenCode file tools read filePath (tool/{edit,write,read,lsp}.ts)", () => {
  test.each([
    ["edit", "fs.write", "/work/repo/src/app.ts", "write"],
    ["write", "fs.write", `${HOME}/.config/opencode/opencode.json`, "write"],
    ["read", "fs.read", `${HOME}/.local/share/opencode/auth.json`, "read"],
    ["lsp", "fs.read", "/work/repo/src/app.ts", "read"],
  ] as const)("%s is %s on %s", async (name, kind, path, how) => {
    const n = await normalize(fromFixture(name), OPTS);
    expect(n).toMatchObject({ kind, paths: [path] });
    expect(access(n)).toEqual({ [path]: how });
  });

  test.each([
    ["glob", `${HOME}/.ssh`],
    ["grep", "/work/repo/src"],
  ])("%s is fs.read on path; the pattern is not a path", async (name, path) => {
    const n = await normalize(fromFixture(name), OPTS);
    expect(n).toMatchObject({ kind: "fs.read", paths: [path] });
  });

  test.todo("T10: the case file taints a file an edit writes from tainted newString", () => {
    throw new Error("pending: context/record.ts reads new_string and newText, not newString");
  });
});

describe("the Pi/OpenCode name collision is settled by the event's harness", () => {
  test.each(["read", "write", "edit"])(
    "%s reads path on Pi, filePath on OpenCode",
    async (tool) => {
      const input = { path: "/pi/x", filePath: "/opencode/x", content: "", edits: [] };
      const pi = await normalize(event("pi", tool, input), OPTS);
      const oc = await normalize(event("opencode", tool, input), OPTS);
      expect([pi.paths, oc.paths]).toEqual([["/pi/x"], ["/opencode/x"]]);
    },
  );

  test("an OpenCode-shaped write on Pi (and the reverse) names no path", async () => {
    const pi = await normalize(event("pi", "write", { filePath: "/etc/x", content: "" }), OPTS);
    const oc = await normalize(event("opencode", "write", { path: "/etc/x", content: "" }), OPTS);
    expect([pi.kind, pi.paths, oc.kind, oc.paths]).toEqual(["fs.write", [], "fs.write", []]);
  });

  test("grep reads path on both; Claude Code keeps the M1 reading of Pi's names", async () => {
    const input = { pattern: "x", path: "/src" };
    const harnesses = ["pi", "opencode", "claude-code"] as const;
    const results = await Promise.all(
      harnesses.map((h) => normalize(event(h, "grep", input), OPTS)),
    );
    expect(results.map((n) => [n.kind, n.paths])).toEqual([
      ["fs.read", ["/src"]],
      ["fs.read", ["/src"]],
      ["fs.read", ["/src"]],
    ]);
  });

  test("OpenCode-only names mean nothing on Pi or Claude Code", async () => {
    for (const harness of ["pi", "claude-code"] as const) {
      const n = await normalize(event(harness, "apply_patch", { patchText: "x" }), OPTS);
      expect(n).toMatchObject({ kind: "other", commands: [] });
    }
  });

  test("Pi's find and ls are not OpenCode tools", async () => {
    const n = await normalize(opencode("ls", { path: "/etc" }), OPTS);
    expect(n).toMatchObject({ kind: "other", paths: [] });
  });
});

describe("normalize: OpenCode task, web, patch, code mode and the rest", () => {
  test("task is spawn; prompt, description and subagent_type stay in raw only", async () => {
    const n = await normalize(fromFixture("task"), OPTS);
    expect(n).toMatchObject({ kind: "spawn", paths: [], hosts: [] });
    expect(verbs(n)).toEqual(["task"]);
  });

  test("webfetch is a GET to the URL's host", async () => {
    const n = await normalize(fromFixture("webfetch"), OPTS);
    expect(n).toMatchObject({ kind: "net", hosts: ["docs.example"] });
    expect(n.commands[0]?.method).toBe("GET");
  });

  test("websearch is net with no host", async () => {
    const n = await normalize(fromFixture("websearch"), OPTS);
    expect(n).toMatchObject({ kind: "net", hosts: [], paths: [] });
  });

  test("apply_patch reads patchText with the same reader as Codex", async () => {
    const n = await normalize(fromFixture("apply_patch"), OPTS);
    expect(n.kind).toBe("fs.delete");
    expect(access(n)).toEqual({
      [`${HOME}/.config/opencode/plugins/evil.ts`]: "write",
      "/work/repo/tmp/scratch.txt": "delete",
    });
    expect(verbs(n)).toEqual([PATCH_VERB, "add", PATCH_VERB, "delete"]);
  });

  test("apply_patch with a malformed patchText or a Codex-shaped input fails closed", async () => {
    const bad = await normalize(opencode("apply_patch", { patchText: "*** Delete File: x" }), OPTS);
    expect([bad.kind, bad.opaque.map((o) => o.reason), bad.paths]).toEqual([
      "exec",
      ["parse-error"],
      ["/work/repo/x"],
    ]);
    const codexShaped = await normalize(opencode("apply_patch", { command: "x" }), OPTS);
    expect(codexShaped.opaque.map((o) => o.reason)).toEqual(["parse-error"]);
  });

  test("execute (code mode) is an opaque interpreter over its code", async () => {
    const n = await normalize(fromFixture("execute"), OPTS);
    const code = "await tools.github.create_issue({ title: 'x' })";
    expect(n).toMatchObject({ kind: "exec", raw: code });
    expect(n.opaque).toEqual([{ reason: "interpreter", span: code }]);
  });

  test("execute without code fails closed", async () => {
    const n = await normalize(opencode("execute", {}), OPTS);
    expect(n.kind).toBe("exec");
  });

  test.each(["todowrite", "question", "plan_exit"])("%s is inert", async (name) => {
    const n = await normalize(fromFixture(name), OPTS);
    expect(n).toMatchObject({ kind: "other", paths: [], opaque: [] });
    expect(verbs(n)).toEqual(["inert"]);
  });

  test("skill loads instruction text: other, not inert (PLAN-M3 §5)", async () => {
    const n = await normalize(fromFixture("skill"), OPTS);
    expect(n).toMatchObject({ kind: "other", commands: [] });
  });

  test("an MCP tool (server_tool) cannot be told from a custom tool: other", async () => {
    const n = await normalize(fromFixture("mcp"), OPTS);
    expect(n).toMatchObject({ kind: "other", commands: [], paths: [] });
  });

  test("every documented call normalizes without falling back to parse-error", async () => {
    const { before } = openCodeBeforeFixtures();
    const names = Object.keys(before);
    const results = await Promise.all(names.map((name) => normalize(fromFixture(name), OPTS)));
    const failed = names.filter((_, i) =>
      results[i]?.opaque.some((o) => o.reason === "parse-error"),
    );
    expect(failed).toEqual([]);
  });
});
