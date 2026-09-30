import { describe, expect, test } from "bun:test";
import {
  commandLine,
  policyGetBaseArgs,
  policyListArgs,
  policySetArgs,
  policyUpdateArgs,
  removeRuleArgs,
  sandboxCreateArgs,
  settingsSetArgs,
} from "./argv.ts";

describe("argv as the v0.1.2 clap definitions spell it", () => {
  test("policy update, one endpoint per call, always --wait --timeout 20", () => {
    const update = {
      ruleName: "jev_cops_task_hosts",
      addEndpoint: "docs.example.com:443:read-only:rest:enforce",
      binaries: ["/usr/local/bin/claude", "/usr/bin/git"],
    };
    expect(policyUpdateArgs("sb", update)).toEqual([
      "policy",
      "update",
      "sb",
      "--rule-name",
      "jev_cops_task_hosts",
      "--binary",
      "/usr/local/bin/claude",
      "--binary",
      "/usr/bin/git",
      "--add-endpoint",
      "docs.example.com:443:read-only:rest:enforce",
      "--wait",
      "--timeout",
      "20",
    ]);
    expect(removeRuleArgs("sb", "jev_cops_jit_1", 5)).toEqual([
      "policy",
      "update",
      "sb",
      "--remove-rule",
      "jev_cops_jit_1",
      "--wait",
      "--timeout",
      "5",
    ]);
  });

  test("policy set / get / list", () => {
    expect(policySetArgs("sb", "/tmp/p.yaml")).toEqual([
      "policy",
      "set",
      "sb",
      "--policy",
      "/tmp/p.yaml",
      "--wait",
      "--timeout",
      "20",
    ]);
    expect(policyGetBaseArgs("sb")).toEqual(["policy", "get", "sb", "--base", "--output", "json"]);
    expect(policyListArgs("sb")).toEqual(["policy", "list", "sb", "--output", "json"]);
  });

  test("sandbox create and settings set", () => {
    const base = {
      name: "sb",
      from: null,
      policyFile: "/p.yaml",
      providers: [],
      env: [],
      command: [],
    };
    expect(sandboxCreateArgs(base)).toEqual([
      "sandbox",
      "create",
      "--name",
      "sb",
      "--policy",
      "/p.yaml",
      "--no-auto-providers",
      "--approval-mode",
      "manual",
      "--detach",
      "--output",
      "json",
    ]);
    const full = sandboxCreateArgs({
      ...base,
      from: "claude-agent:local",
      providers: ["anthropic"],
      env: ["CI=1"],
      command: ["claude"],
    });
    expect(full.slice(4, 6)).toEqual(["--from", "claude-agent:local"]);
    expect(full).toContain("--provider");
    expect(full.slice(-2)).toEqual(["--", "claude"]);
    expect(settingsSetArgs("sb", "proposal_approval_mode", "manual")).toEqual([
      "settings",
      "set",
      "sb",
      "--key",
      "proposal_approval_mode",
      "--value",
      "manual",
    ]);
  });

  test("commandLine quotes what a shell would split", () => {
    expect(commandLine("openshell", ["a", "b c", "it's"])).toBe(`openshell a 'b c' 'it'\\''s'`);
  });
});
