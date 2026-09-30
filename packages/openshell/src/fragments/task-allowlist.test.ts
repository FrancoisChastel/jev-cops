import { describe, expect, test } from "bun:test";
import { parsePolicy } from "../schema.ts";
import { JUDGE_PROVIDER_HOSTS, t13Refusals } from "./judge-hosts.ts";
import { type TaskAllowlistInput, taskAllowlistFragment } from "./task-allowlist.ts";

const CLAUDE = ["/usr/local/bin/claude"];

function fragment(over: Partial<TaskAllowlistInput>) {
  return taskAllowlistFragment({
    task: null,
    repo: null,
    binaries: CLAUDE,
    judgeHosts: JUDGE_PROVIDER_HOSTS,
    ...over,
  });
}

const HTTPS = { host: "github.com", transport: "https", port: 443 } as const;
const SSH = { host: "github.com", transport: "ssh", port: 22 } as const;

describe("task allowlist (spec §Policy compilation 1, PLAN-M2 §4)", () => {
  test("npm lockfile + https remote: read-only registry with encoded slashes, read-write remote", () => {
    const f = fragment({ repo: { lockfiles: ["package-lock.json"], remote: HTTPS } });
    expect(f.refusals).toEqual([]);
    expect(f.rules.jev_cops_task_registries).toEqual({
      endpoints: [
        {
          host: "registry.npmjs.org",
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          access: "read-only",
          allow_encoded_slash: true,
        },
      ],
      binaries: [{ path: "/usr/local/bin/claude" }],
    });
    expect(f.rules.jev_cops_task_remote?.endpoints).toEqual([
      {
        host: "github.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        access: "read-write",
      },
    ]);
    expect(parsePolicy({ version: 1, network_policies: f.rules }).ok).toBe(true);
  });

  test("ssh remote: tcp with tls skip on its port", () => {
    const f = fragment({ repo: { lockfiles: [], remote: SSH } });
    expect(f.rules.jev_cops_task_remote?.endpoints).toEqual([
      { host: "github.com", port: 22, protocol: "tcp", tls: "skip" },
    ]);
    expect(parsePolicy({ version: 1, network_policies: f.rules }).ok).toBe(true);
  });

  test("python lockfile: both PyPI hosts, no encoded slashes", () => {
    const f = fragment({ repo: { lockfiles: ["poetry.lock"], remote: null } });
    const hosts = f.rules.jev_cops_task_registries?.endpoints?.map((e) => e.host);
    expect(hosts).toEqual(["pypi.org", "files.pythonhosted.org"]);
    expect(f.rules.jev_cops_task_registries?.endpoints?.[0]?.allow_encoded_slash).toBeUndefined();
  });

  test("hosts named in the task are read-only; file names are not hosts", () => {
    const f = fragment({
      task: "Fix the client per https://docs.example.com/v2 and api.stripe.com; see README.md",
    });
    const hosts = f.rules.jev_cops_task_hosts?.endpoints?.map((e) => e.host);
    expect(hosts).toEqual(["docs.example.com", "api.stripe.com"]);
    expect(f.rules.jev_cops_task_hosts?.endpoints?.[0]?.access).toBe("read-only");
    expect(f.updates).toEqual([
      {
        ruleName: "jev_cops_task_hosts",
        addEndpoint: "docs.example.com:443:read-only:rest:enforce",
        binaries: CLAUDE,
      },
      {
        ruleName: "jev_cops_task_hosts",
        addEndpoint: "api.stripe.com:443:read-only:rest:enforce",
        binaries: CLAUDE,
      },
    ]);
  });

  test("a host already allowed by the remote or a registry is listed once", () => {
    const f = fragment({
      task: "push to github.com and check registry.npmjs.org",
      repo: { lockfiles: ["bun.lock"], remote: HTTPS },
    });
    expect(f.rules.jev_cops_task_hosts).toBeUndefined();
  });

  test("T13: judge provider hosts are never allowed, whatever names them", () => {
    const f = fragment({
      task: "compare openrouter.ai with https://api.typesafe.ai/docs and eu.openrouter.ai",
      repo: { lockfiles: [], remote: { host: "openrouter.ai", transport: "https", port: 443 } },
    });
    expect(Object.keys(f.rules)).toEqual([]);
    const absent = f.absent.map((a) => a.host);
    expect(absent).toEqual(
      expect.arrayContaining(["openrouter.ai", "api.typesafe.ai", "eu.openrouter.ai"]),
    );
    expect(f.absent.every((a) => a.why.includes("T13"))).toBe(true);
  });

  test("an operator-configured judge host is kept out too", () => {
    const f = fragment({
      task: "read llm.corp.example",
      judgeHosts: [...JUDGE_PROVIDER_HOSTS, "llm.corp.example"],
    });
    expect(f.rules).toEqual({});
  });

  test("the gateway host is reachable only through the judge route", () => {
    const f = fragment({ task: "curl host.openshell.internal" });
    expect(f.rules).toEqual({});
    expect(f.absent[0]?.why).toContain("judge route");
  });

  test("no binaries: refused, the rules would match nothing", () => {
    const f = fragment({ task: "see docs.example.com", binaries: [] });
    expect(f.refusals.join()).toContain("binar");
  });

  test("nothing to allow: no rules, no updates", () => {
    const f = fragment({});
    expect(f.rules).toEqual({});
    expect(f.updates).toEqual([]);
  });
});

describe("t13Refusals", () => {
  test("any endpoint that can reach a judge provider host refuses the policy", () => {
    expect(JUDGE_PROVIDER_HOSTS).toEqual(["api.typesafe.ai", "openrouter.ai"]);
    const policy = {
      version: 1 as const,
      network_policies: {
        x: { endpoints: [{ host: "*.openrouter.ai", port: 443 }] },
        y: { endpoints: [{ host: "registry.npmjs.org", port: 443 }] },
      },
    };
    const refusals = t13Refusals(policy, JUDGE_PROVIDER_HOSTS);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("network_policies.x");
    expect(t13Refusals({ version: 1 }, JUDGE_PROVIDER_HOSTS)).toEqual([]);
  });
});
