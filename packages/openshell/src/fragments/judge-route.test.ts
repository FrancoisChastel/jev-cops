import { describe, expect, test } from "bun:test";
import { defaultLayout } from "../layout.ts";
import { parsePolicy } from "../schema.ts";
import { JUDGE_HOST, JUDGE_RULE, judgeRouteFragment } from "./judge-route.ts";

describe("jev_cops_judge (D-105)", () => {
  test("Claude Code: only cops-hook, only the four routes its client calls", () => {
    const f = judgeRouteFragment("claude-code", defaultLayout("claude-code"), { port: 17681 });
    expect(f.refusals).toEqual([]);
    const rule = f.rules[JUDGE_RULE];
    expect(rule?.binaries).toEqual([{ path: "/usr/local/libexec/jev-cops/cops-hook" }]);
    expect(rule?.endpoints).toEqual([
      {
        host: JUDGE_HOST,
        port: 17681,
        protocol: "rest",
        enforcement: "enforce",
        rules: [
          { allow: { method: "POST", path: "/v1/judge" } },
          { allow: { method: "POST", path: "/v1/observe" } },
          { allow: { method: "POST", path: "/v1/session" } },
          { allow: { method: "GET", path: "/v1/explain/*" } },
        ],
      },
    ]);
    expect(parsePolicy({ version: 1, network_policies: f.rules }).ok).toBe(true);
  });

  test("Pi: the node interpreter, resolve instead of session", () => {
    const f = judgeRouteFragment("pi", defaultLayout("pi"), { port: 17681 });
    const rule = f.rules[JUDGE_RULE];
    expect(rule?.binaries).toEqual([{ path: "/usr/local/bin/node" }]);
    const paths = rule?.endpoints?.[0]?.rules?.map((r) => r.allow.path);
    expect(paths).toContain("/v1/resolve");
    expect(paths).not.toContain("/v1/session");
  });

  test("no judge: no rule, recorded as absent", () => {
    const f = judgeRouteFragment("claude-code", defaultLayout("claude-code"), null);
    expect(f.rules).toEqual({});
    expect(f.absent[0]?.host).toBe(JUDGE_HOST);
  });

  test("refused without a client binary or with a bad port", () => {
    const noHook = { ...defaultLayout("claude-code"), hookBinary: null };
    expect(judgeRouteFragment("claude-code", noHook, { port: 1 }).refusals.join()).toContain(
      "binary",
    );
    const layout = defaultLayout("claude-code");
    expect(judgeRouteFragment("claude-code", layout, { port: 0 }).refusals.join()).toContain(
      "port",
    );
  });
});
