import { describe, expect, test } from "bun:test";
import {
  ancestorTier,
  CONFIG_TREES,
  canon,
  killMarkers,
  type PlacedTree,
  pathTier,
  placeTrees,
  projectRoots,
  TIER_RANK,
  type Tier,
  treeEntries,
  WINDOWS_MANAGED,
} from "./config-trees.ts";

const HOME = "/home/dev";
const REPO = "/work/repo";

/** The trees of a call in `cwd` inside REPO, with `protectedPaths`. */
function trees(cwd = REPO, protectedPaths: readonly string[] = []): PlacedTree[] {
  return placeTrees({ home: HOME, projectRoots: projectRoots(cwd, REPO, HOME), protectedPaths });
}

const rows = (paths: readonly string[], tier: Tier | null) => paths.map((p) => [p, tier] as const);

describe("pathTier", () => {
  test.each(
    rows(
      [
        `${HOME}/.claude/settings.json`,
        `${HOME}/.claude/settings.local.json`,
        `${HOME}/.claude/hooks/pre-tool.sh`,
        `${HOME}/.claude/plugins/cache/p/plugin.json`,
        `${HOME}/.claude.json`,
        `${HOME}/.codex/config.toml`,
        `${HOME}/.codex/hooks.json`,
        `${HOME}/.codex/rules/default.rules`,
        `${HOME}/.config/opencode/plugin/x.ts`,
        `${HOME}/.config/opencode/opencode.jsonc`,
        `${HOME}/.pi/agent/extensions/jev-cops.ts`,
        `${HOME}/.pi/agent/settings.json`,
        `${HOME}/.config/jev-cops/cops.toml`,
        `${HOME}/.jev-cops/audit.jsonl`,
      ],
      "kill",
    ),
  )("home kill tier: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        `${REPO}/.claude/settings.json`,
        `${REPO}/.claude/settings.local.json`,
        `${REPO}/.claude/hooks/guard.sh`,
        `${REPO}/.codex/config.toml`,
        `${REPO}/.opencode/plugins/evil.ts`,
        `${REPO}/opencode.json`,
        `${REPO}/opencode.jsonc`,
        `${REPO}/.pi/extensions/evil.ts`,
        `${REPO}/.pi/settings.json`,
        `${REPO}/.cops.toml`,
      ],
      "kill",
    ),
  )("project kill tier: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        `${HOME}/.claude/CLAUDE.md`,
        `${HOME}/.claude/skills/x/SKILL.md`,
        `${HOME}/.claude/projects/-work-repo/session.jsonl`,
        `${HOME}/.codex/AGENTS.md`,
        `${HOME}/.config/opencode/agent/reviewer.md`,
        `${HOME}/.pi/agent/sessions/s.jsonl`,
        `${REPO}/.claude/agents/reviewer.md`,
        `${REPO}/.opencode/agent/reviewer.md`,
        `${REPO}/.pi/prompts/p.md`,
        `${REPO}/.mcp.json`,
      ],
      "hold",
    ),
  )("hold tier: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        `${HOME}/.claude/projects/-work-repo/memory/auth-notes.md`,
        `${HOME}/.claude/plans/fix-flaky-auth.md`,
        `${HOME}/.claude/todos/session.json`,
      ],
      "annotate",
    ),
  )("annotate tier: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        "/etc/claude-code/managed-settings.d/99-x.json",
        "/Library/Application Support/ClaudeCode/managed-settings.json",
        "/c/Program Files/ClaudeCode/managed-settings.json",
        "C:\\Program Files\\ClaudeCode\\managed-settings.json",
        `${REPO}/C:\\Program Files\\ClaudeCode\\managed-settings.json`,
      ],
      "kill",
    ),
  )("managed settings, absolute or Windows: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        `${REPO}/src/config.ts`,
        `${REPO}/src/.claude-notes.md`,
        `${REPO}/.claude/worktrees/wt1/auth/session.test.ts`,
        `${HOME}/notes.md`,
        `${HOME}/.claudex/settings.json`,
        "/tmp/settings.json",
      ],
      null,
    ),
  )("no tree, or an ignore rule: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test.each([
    [`${HOME}/.claude`, "kill"],
    [`${HOME}/.pi`, "kill"],
    [`${HOME}/.pi/agent`, "kill"],
    [`${HOME}/.config/opencode`, "kill"],
    [`${REPO}/.claude`, "kill"],
    [`${REPO}/.opencode`, "kill"],
    [`${HOME}/.claude/skills`, "hold"],
  ] as const)("a directory holding a kill rule is kill: %s → %s", (path, tier) => {
    expect(pathTier(path, trees())).toBe(tier);
  });

  test("matching is case-insensitive, backslashes are slashes, trailing slashes ignored", () => {
    const placed = trees();
    expect(pathTier("/HOME/Dev/.Claude/Settings.JSON", placed)).toBe("kill");
    expect(pathTier("\\home\\dev\\.claude\\settings.json", placed)).toBe("kill");
    expect(pathTier(`${HOME}/.claude/hooks/`, placed)).toBe("kill");
  });

  test("the highest tier of every placed tree wins", () => {
    // A protected directory raises a hold-tier path under it to kill; a sibling stays hold.
    const placed = trees(REPO, [`${REPO}/.claude/agents`]);
    expect(pathTier(`${REPO}/.claude/agents/reviewer.md`, placed)).toBe("kill");
    expect(pathTier(`${REPO}/.claude/skills/s/SKILL.md`, placed)).toBe("hold");
  });

  test("an empty tree list covers nothing", () => {
    expect(pathTier(`${HOME}/.claude/settings.json`, [])).toBeNull();
  });
});

describe("ancestorTier", () => {
  test.each(
    rows(
      [
        HOME,
        "/home",
        "/",
        `${HOME}/.config`,
        REPO,
        "/work",
        "/etc",
        "/Library",
        "/Library/Application Support",
        "/c/Program Files",
        "C:\\Program Files",
        `${REPO}/C:`,
      ],
      "kill",
    ),
  )("a directory above a kill-tier tree root takes its tier: %s → %s", (path, tier) => {
    expect(ancestorTier(path, trees())).toBe(tier);
  });

  test.each(
    rows(
      [
        `${REPO}/build`,
        `${REPO}/src`,
        `${HOME}/notes.md`,
        `${HOME}/.cache`,
        `${HOME}/.claude`,
        `${HOME}/.claude/settings.json`,
        "/tmp",
        "/work/other",
      ],
      null,
    ),
  )("above no tree root (a root is not its own ancestor): %s → %s", (path, tier) => {
    expect(ancestorTier(path, trees())).toBe(tier);
  });

  test("protected paths count like trees: the directories above them are kill", () => {
    const placed = trees(REPO, ["/opt/jev/bin/cops-hook"]);
    expect(ancestorTier("/opt/jev/bin", placed)).toBe("kill");
    expect(ancestorTier("/opt", placed)).toBe("kill");
    expect(ancestorTier("/opt/other", placed)).toBeNull();
  });

  test("the highest tier of the trees below wins; an ignore rule counts for nothing", () => {
    const placed: PlacedTree[] = [
      { base: "/a/b/.mcp.json", rest: "hold", rules: [] },
      { base: "/a/c/data", rest: "annotate", rules: [{ segs: ["wt"], tier: "ignore" }] },
      { base: "/a/d/conf", rest: "hold", rules: [{ segs: ["hooks"], tier: "kill" }] },
    ];
    expect(ancestorTier("/a/b", placed)).toBe("hold");
    expect(ancestorTier("/a/c", placed)).toBe("annotate");
    expect(ancestorTier("/a/d", placed)).toBe("kill");
    expect(ancestorTier("/a", placed)).toBe("kill");
  });

  test("case-insensitive, trailing slashes ignored; home itself is in no tree", () => {
    const placed = trees();
    expect(ancestorTier("/HOME/Dev/", placed)).toBe("kill");
    expect(pathTier(HOME, placed)).toBeNull();
  });

  test("an empty tree list is below nothing", () => {
    expect(ancestorTier("/", [])).toBeNull();
  });
});

describe("placement", () => {
  test("project trees sit at the cwd, the repo root and every parent, never home", () => {
    const deep = trees(`${REPO}/packages/core`);
    expect(pathTier("/work/.claude/settings.json", deep)).toBe("kill");
    expect(pathTier("/.claude/settings.json", deep)).toBe("kill");
    expect(pathTier(`${REPO}/packages/core/.cops.toml`, deep)).toBe("kill");
    // Home is not a project root: a `.mcp.json` there is not the project's.
    expect(pathTier(`${HOME}/.mcp.json`, trees(`${HOME}/proj`))).toBeNull();
  });

  test("a relative protected path is placed under each project root, an absolute one once", () => {
    const placed = trees(REPO, ["policies", "/opt/jev/bin/cops-hook"]);
    expect(pathTier(`${REPO}/policies/_lib/config-trees.ts`, placed)).toBe("kill");
    expect(pathTier("/work/policies/x.ts", placed)).toBe("kill");
    expect(pathTier("/opt/jev/bin/cops-hook", placed)).toBe("kill");
    expect(pathTier("/opt/jev/bin/other", placed)).toBeNull();
  });

  test("the daemon's policies dir as a protected path covers _lib/ whole", () => {
    const placed = trees(REPO, [`${REPO}/policies`]);
    expect(pathTier(`${REPO}/policies/_lib/config-trees.ts`, placed)).toBe("kill");
    expect(pathTier(`${REPO}/policies/_lib`, placed)).toBe("kill");
  });

  test("every tree is placed at each of its bases, canonical", () => {
    const roots = projectRoots(REPO, REPO, HOME);
    const placed = placeTrees({ home: "/Home/Dev/", projectRoots: roots, protectedPaths: ["/X"] });
    const count = (anchor: string) => CONFIG_TREES.filter((t) => t.anchor === anchor).length;
    expect(placed).toHaveLength(
      count("home") + count("project") * roots.length + count("absolute") + 1,
    );
    expect(placed.map((p) => p.base)).toContain("/home/dev/.claude");
    expect(placed.map((p) => p.base)).toContain("/x");
    expect(placed.every((p) => p.base === canon(p.base))).toBe(true);
  });

  test.each([
    [REPO, REPO, ["/work/repo", "/work", "/"]],
    [`${REPO}/sub`, REPO, ["/work/repo/sub", "/work/repo", "/work", "/"]],
    ["/Work/Repo", null, ["/work/repo", "/work", "/"]],
    [`${HOME}/proj`, undefined, ["/home/dev/proj", "/home", "/"]],
    ["/elsewhere", REPO, ["/elsewhere", "/", "/work/repo", "/work"]],
    ["relative/dir", "", []],
  ] as const)("projectRoots(%p, %p)", (cwd, repo, expected) => {
    expect(projectRoots(cwd, repo, HOME)).toEqual([...expected]);
  });
});

describe("markers", () => {
  test("kill-tier tree paths as code names them, then the Windows dir, then protected paths", () => {
    const markers = killMarkers(["/Opt/Jev/Bin/Cops-Hook"]);
    expect(markers[0]).toBe(".claude/settings.json");
    expect(markers).toContain(".claude.json");
    expect(markers).toContain(".codex/rules");
    expect(markers).toContain(".pi/agent/extensions");
    expect(markers).toContain(".jev-cops");
    expect(markers).toContain("/etc/claude-code");
    expect(markers.slice(-2)).toEqual([WINDOWS_MANAGED, "/opt/jev/bin/cops-hook"]);
  });

  test("hold, annotate and ignore entries are never markers", () => {
    const markers = killMarkers([]);
    for (const m of [".claude", ".claude/plans", ".mcp.json", ".claude/worktrees", ".pi"]) {
      expect({ m, marker: markers.includes(m) }).toEqual({ m, marker: false });
    }
  });

  test("each marker is a kill-tier entry of a tree", () => {
    const kills = CONFIG_TREES.flatMap(treeEntries).filter((e) => e.tier === "kill");
    expect(killMarkers([]).slice(0, -1)).toEqual(kills.map((e) => e.path));
  });
});

describe("trees and entries", () => {
  test("treeEntries lists the root with its rest tier, then each rule", () => {
    const claude = CONFIG_TREES.find((t) => t.anchor === "home" && t.root === ".claude");
    expect(claude === undefined ? [] : treeEntries(claude)).toEqual([
      { path: ".claude", tier: "hold" },
      { path: ".claude/settings.json", tier: "kill" },
      { path: ".claude/settings.local.json", tier: "kill" },
      { path: ".claude/hooks", tier: "kill" },
      { path: ".claude/plugins", tier: "kill" },
      { path: ".claude/projects/*/memory", tier: "annotate" },
      { path: ".claude/plans", tier: "annotate" },
      { path: ".claude/todos", tier: "annotate" },
    ]);
  });

  test("the trees are frozen, owned, and anchored consistently", () => {
    expect(Object.isFrozen(CONFIG_TREES)).toBe(true);
    for (const t of CONFIG_TREES) {
      expect(Object.isFrozen(t) && (t.rules === undefined || Object.isFrozen(t.rules))).toBe(true);
      expect(t.root.startsWith("/")).toBe(t.anchor === "absolute");
      expect(t.root).toBe(t.root.toLowerCase());
    }
    const owners = new Set(CONFIG_TREES.map((t) => t.owner));
    expect([...owners].sort()).toEqual(["claude-code", "codex", "jev-cops", "opencode", "pi"]);
  });

  test("canon: slashes, lower case, no trailing slash, the root kept", () => {
    expect(canon("C:\\Users\\Dev\\")).toBe("c:/users/dev");
    expect(canon("/Work/Repo///")).toBe("/work/repo");
    expect(canon("/")).toBe("/");
    expect(canon("")).toBe("");
  });

  test("TIER_RANK orders annotate < hold < kill", () => {
    expect(TIER_RANK.annotate).toBeLessThan(TIER_RANK.hold);
    expect(TIER_RANK.hold).toBeLessThan(TIER_RANK.kill);
  });
});
