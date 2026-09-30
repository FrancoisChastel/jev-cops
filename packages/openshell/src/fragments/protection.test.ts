import { describe, expect, test } from "bun:test";
import { CONFIG_TREES, treeEntries } from "@jev-cops/policies/_lib/config-trees";
import { defaultLayout, type Harness, type SandboxLayout } from "../layout.ts";
import { parsePolicy } from "../schema.ts";
import { BASELINE_READ_ONLY, BASELINE_READ_WRITE, protectionFragment } from "./protection.ts";

function fragment(harness: Harness, over: Partial<SandboxLayout> = {}, extra: object = {}) {
  return protectionFragment({
    harness,
    layout: { ...defaultLayout(harness), ...over },
    protectedPaths: [],
    privatePaths: [],
    extraReadWrite: [],
    ...extra,
  });
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Every kill-tier path of `harness`'s home trees, straight from config-tamper's lists. */
function killPaths(harness: Harness, home: string): string[] {
  return CONFIG_TREES.filter((t) => t.owner === harness && t.anchor === "home").flatMap((t) =>
    treeEntries(t)
      .filter((e) => e.tier === "kill")
      .map((e) => `${home}/${e.path}`),
  );
}

describe("Claude Code protection set (D-107)", () => {
  const f = fragment("claude-code");
  const ro = f.filesystem.read_only;
  const rw = f.filesystem.read_write;

  test("no refusal; landlock hard_requirement; no workdir; uid 1000", () => {
    expect(f.refusals).toEqual([]);
    expect(f.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(f.filesystem.include_workdir).toBe(false);
    expect(f.process).toEqual({ run_as_user: "1000", run_as_group: "1000" });
  });

  test("the baseline is repeated so a later policy set never drops it", () => {
    for (const p of BASELINE_READ_ONLY) expect(ro).toContain(p);
    for (const p of BASELINE_READ_WRITE) expect(rw).toContain(p);
  });

  test("T1: every kill-tier config path is read_only or a printed gap, none under read_write", () => {
    for (const k of killPaths("claude-code", "/home/agent")) {
      if (k === "/home/agent/.claude.json") {
        expect(f.gaps.join("\n")).toContain(".claude.json");
        continue;
      }
      expect(ro).toContain(k);
      expect(rw.filter((r) => under(k, r))).toEqual([]);
    }
    expect(ro).toContain("/home/agent/.claude");
    expect(ro).toContain("/etc/claude-code");
    expect(ro).toContain("/usr/local/libexec/jev-cops");
  });

  test("the harness's data dirs and the workspace are writable", () => {
    for (const p of ["plans", "todos", "projects"])
      expect(rw).toContain(`/home/agent/.claude/${p}`);
    expect(rw).toContain("/home/agent/.claude.json");
    expect(rw).toContain("/sandbox");
  });

  test("private records and other harnesses' config are unlisted, hence unreadable", () => {
    const listed = [...ro, ...rw];
    for (const hidden of ["/home/agent/.jev-cops", "/home/agent/.codex", "/home/agent/.pi"]) {
      expect(listed.filter((p) => under(p, hidden) || under(hidden, p))).toEqual([]);
    }
    const why = (p: string) => f.absent.find((a) => a.path === p)?.why ?? "";
    expect(why("/home/agent/.jev-cops")).toContain("private");
    expect(why("/home/agent/.codex")).toContain("inaccessible");
  });

  test("gaps name the project config the kernel cannot protect", () => {
    expect(f.gaps.join("\n")).toContain("/sandbox/.claude/settings.json");
  });

  test("the fragment passes the schema mirror", () => {
    const policy = { version: 1, filesystem_policy: f.filesystem, landlock: f.landlock };
    expect(parsePolicy(policy).ok).toBe(true);
  });
});

describe("Pi protection set", () => {
  const f = fragment("pi");

  test("extensions and settings read-only, sessions writable, extension dir listed", () => {
    expect(f.refusals).toEqual([]);
    const ro = f.filesystem.read_only;
    for (const k of killPaths("pi", "/home/agent")) expect(ro).toContain(k);
    expect(ro).toContain("/opt/jev-cops");
    expect(f.filesystem.read_write).toContain("/home/agent/.pi/agent/sessions");
    expect([...ro, ...f.filesystem.read_write].some((p) => p.includes(".claude"))).toBe(false);
  });

  test("no process section when the layout leaves identity to the driver", () => {
    expect(fragment("pi", { runAs: null }).process).toBeUndefined();
  });
});

describe("refusals: Landlock grants, never revokes", () => {
  test("HOME inside the workspace", () => {
    const f = fragment("claude-code", { home: "/sandbox/home" });
    expect(f.refusals.join("\n")).toContain(
      "HOME /sandbox/home is inside the read_write workspace",
    );
    expect(f.refusals.join("\n")).toContain("/sandbox/home/.claude/settings.json");
  });

  test("a writable HOME exposes kill-tier config and the private records", () => {
    const text = fragment("claude-code", {}, { extraReadWrite: ["/home/agent"] }).refusals.join(
      "\n",
    );
    expect(text).toContain("/home/agent/.claude/settings.json sits under read_write /home/agent");
    expect(text).toContain("/home/agent/.jev-cops");
  });

  test("a writable config dir, or a kill-tier dir itself", () => {
    const whole = fragment("claude-code", {}, { extraReadWrite: ["/home/agent/.claude"] });
    expect(whole.refusals.join("\n")).toContain("kill tier");
    const hooks = fragment("claude-code", {}, { extraReadWrite: ["/home/agent/.claude/hooks"] });
    expect(hooks.refusals.join("\n")).toContain("/home/agent/.claude/hooks is kill tier");
  });

  test("the adapter binary or a protected path inside the workspace", () => {
    const hook = fragment("claude-code", { hookBinary: "/sandbox/bin/cops-hook" });
    expect(hook.refusals.join("\n")).toContain("/sandbox/bin/cops-hook");
    const extra = fragment("claude-code", {}, { protectedPaths: ["/sandbox/.cops-bin"] });
    expect(extra.refusals.join("\n")).toContain("/sandbox/.cops-bin");
  });

  test("a private path listed readable", () => {
    const f = fragment("claude-code", {}, { privatePaths: ["/usr/share/secret"] });
    expect(f.refusals.join("\n")).toContain("/usr/share/secret");
  });

  test("bad paths: relative, parent traversal, the root", () => {
    expect(fragment("claude-code", { workspace: "sandbox" }).refusals.join()).toContain("absolute");
    const dots = fragment("claude-code", {}, { extraReadWrite: ["/sandbox/../home/agent"] });
    expect(dots.refusals.join()).toContain("..");
    expect(fragment("claude-code", {}, { extraReadWrite: ["/"] }).refusals.join()).toContain("/");
  });

  test("more than 256 paths", () => {
    const many = Array.from({ length: 256 }, (_, i) => `/data/d${i}`);
    expect(fragment("claude-code", {}, { extraReadWrite: many }).refusals.join()).toContain("256");
  });

  test("HOME equal to the workspace", () => {
    const f = fragment("claude-code", { home: "/sandbox" });
    expect(f.refusals.join("\n")).toContain("HOME /sandbox is inside");
  });
});
