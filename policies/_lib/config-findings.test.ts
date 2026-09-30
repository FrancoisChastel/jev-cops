import { describe, expect, test } from "bun:test";
import { buildPolicyEvent, type PolicyEvent } from "@jev-cops/core";
import { bashPre, toolEvent } from "../../tests/fixtures/context/index.ts";
import {
  accessFindings,
  harnessCliFindings,
  mentionFindings,
  type TreeConfig,
  treesFor,
} from "./config-findings.ts";

const CONFIG: TreeConfig = { home: "/home/dev", protectedPaths: [] };

async function bash(command: string, cwd?: string): Promise<PolicyEvent> {
  return buildPolicyEvent(await bashPre(command, cwd === undefined ? {} : { cwd }), null);
}

async function write(path: string): Promise<PolicyEvent> {
  const n = await toolEvent("Write", "fs.write", { file_path: path, content: "{}" });
  return buildPolicyEvent(n, null);
}

function access(e: PolicyEvent, config: TreeConfig = CONFIG) {
  return accessFindings(e, treesFor(e, config));
}

describe("accessFindings", () => {
  test("a write takes the path's tier", async () => {
    const e = await write("/home/dev/.claude/settings.json");
    expect(access(e)).toEqual([
      { tier: "kill", target: "/home/dev/.claude/settings.json", how: "write" },
    ]);
    expect(access(await write("/home/dev/.claude/plans/p.md"))).toEqual([
      { tier: "annotate", target: "/home/dev/.claude/plans/p.md", how: "write" },
    ]);
  });

  test("a delete of a directory holding a kill path is kill", async () => {
    expect(access(await bash("rm -rf ~/.claude"))).toEqual([
      { tier: "kill", target: "/home/dev/.claude", how: "delete" },
    ]);
  });

  test("unknown access to a kill path is capped at hold; reads never count", async () => {
    expect(access(await bash("jq '.hooks' ~/.claude/settings.json"))).toEqual([
      { tier: "hold", target: "/home/dev/.claude/settings.json", how: "unknown" },
    ]);
    expect(access(await bash("cat ~/.claude/settings.json"))).toEqual([]);
  });

  test("trees follow the call's cwd and the daemon's protected paths", async () => {
    const e = await write("/work/repo/policies/_lib/config-trees.ts");
    expect(access(e)).toEqual([]);
    const guarded = { ...CONFIG, protectedPaths: ["/work/repo/policies"] };
    expect(access(e, guarded)).toEqual([
      { tier: "kill", target: "/work/repo/policies/_lib/config-trees.ts", how: "write" },
    ]);
  });
});

describe("mentionFindings", () => {
  test("opaque code naming a kill-tier path is held, naming the first marker it contains", async () => {
    const e = await bash(`python -c "open('$HOME/.claude/settings.json','w').write('{}')"`);
    expect(mentionFindings(e, CONFIG)).toEqual([
      { tier: "hold", target: ".claude/settings.json", how: "mention" },
    ]);
  });

  test("a protected path named in opaque code is held", async () => {
    const e = await bash(`node -e "require('fs').writeFileSync('/opt/jev/cops-hook','')"`);
    const config = { ...CONFIG, protectedPaths: ["/opt/jev/cops-hook"] };
    expect(mentionFindings(e, config)).toEqual([
      { tier: "hold", target: "/opt/jev/cops-hook", how: "mention" },
    ]);
  });

  test("plain commands and opaque code naming nothing are not mentions", async () => {
    expect(mentionFindings(await bash("cat ~/.claude/settings.json"), CONFIG)).toEqual([]);
    expect(mentionFindings(await bash(`python -c "print(1)"`), CONFIG)).toEqual([]);
  });
});

describe("harnessCliFindings", () => {
  test.each([
    ["claude mcp add evil -- npx -y evil-server", "claude mcp add"],
    ["claude config set -g theme dark", "claude config set"],
  ])("%s → %s", async (command, target) => {
    expect(harnessCliFindings(await bash(command))).toEqual([{ tier: "hold", target, how: "cli" }]);
  });

  test("a read-only harness command is not a finding", async () => {
    expect(harnessCliFindings(await bash("claude mcp list"))).toEqual([]);
  });
});
