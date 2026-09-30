import { describe, expect, test } from "bun:test";
import { parsePolicy, parsePolicyYaml } from "./schema.ts";

/** The "Full Example" of docs/how-it-works/policies/schema.mdx:601-629, verbatim. */
const DOCS_FULL_EXAMPLE = `version: 1

filesystem_policy:
  include_workdir: true
  read_only: [/usr, /lib, /etc]
  read_write: [/tmp]

network_policies:
  github_rest_api:
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    binaries:
      - path: /usr/bin/gh
  npm_registry:
    endpoints:
      - host: registry.npmjs.org
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
        allow_encoded_slash: true
    binaries:
      - path: /usr/bin/node
`;

type Json = Record<string, unknown>;

function endpointPolicy(endpoint: Json, extra: Json = {}): Json {
  return {
    version: 1,
    network_policies: { r: { endpoints: [endpoint], binaries: [{ path: "/usr/bin/curl" }] } },
    ...extra,
  };
}

function problems(value: unknown): string {
  const parsed = parsePolicy(value);
  return parsed.ok ? "" : parsed.error.join("\n");
}

const REST = { host: "api.example.com", port: 443, protocol: "rest", enforcement: "enforce" };

describe("documented valid shapes", () => {
  test("the schema reference's full example parses", () => {
    const parsed = parsePolicyYaml(DOCS_FULL_EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.network_policies?.npm_registry?.binaries).toHaveLength(1);
  });

  test("tcp with tls skip, rules with deny_rules, process, landlock, middleware", () => {
    const policy = {
      version: 1,
      filesystem_policy: { read_only: ["/usr"], read_write: ["/sandbox"] },
      landlock: { compatibility: "hard_requirement" },
      process: { run_as_user: "1000", run_as_group: "sandbox" },
      network_policies: {
        ssh: {
          endpoints: [{ host: "github.com", port: 22, protocol: "tcp", tls: "skip" }],
          binaries: [{ path: "/usr/bin/ssh" }],
        },
        api: {
          endpoints: [
            {
              ...REST,
              rules: [{ allow: { method: "GET", path: "/repos/**" } }],
              deny_rules: [{ method: "GET", path: "/repos/private/**" }],
            },
          ],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
      network_middlewares: {
        redact: { middleware: "openshell/regex", order: 10, endpoints: { include: ["*.a.com"] } },
      },
    };
    expect(problems(policy)).toBe("");
  });

  test("an mcp endpoint with allow_all_known_mcp_methods needs no rules", () => {
    const mcp = { versions: ["2025-11-25"], allow_all_known_mcp_methods: true };
    expect(problems(endpointPolicy({ ...REST, protocol: "mcp", mcp }))).toBe("");
  });
});

describe("documented invalid shapes are rejected", () => {
  const cases: ReadonlyArray<[string, unknown, string]> = [
    ["unknown field", { version: 1, extra: true }, "extra"],
    ["version other than 1", { version: 2 }, "version"],
    ["relative path", { version: 1, filesystem_policy: { read_only: ["usr"] } }, "absolute"],
    ["parent traversal", { version: 1, filesystem_policy: { read_only: ["/a/../b"] } }, ".."],
    [
      "path over 4096 bytes",
      { version: 1, filesystem_policy: { read_only: [`/${"a".repeat(4096)}`] } },
      "4096",
    ],
    ["read_write /", { version: 1, filesystem_policy: { read_write: ["/"] } }, "read_write"],
    ["read_write //", { version: 1, filesystem_policy: { read_write: ["//"] } }, "read_write"],
    [
      "257 paths",
      {
        version: 1,
        filesystem_policy: { read_only: Array.from({ length: 257 }, (_, i) => `/p${i}`) },
      },
      "256",
    ],
    ["bad landlock", { version: 1, landlock: { compatibility: "strict" } }, "compatibility"],
    ["root identity", { version: 1, process: { run_as_user: "0" } }, "run_as_user"],
    ["named identity", { version: 1, process: { run_as_group: "wheel" } }, "run_as_group"],
    [
      "_provider_ key",
      { version: 1, network_policies: { _provider_x: { endpoints: [] } } },
      "_provider_",
    ],
    ["port and ports", endpointPolicy({ ...REST, access: "full", ports: [443] }), "port"],
    ["no port", endpointPolicy({ host: "a.example.com" }), "port"],
    ["port 0", endpointPolicy({ host: "a.example.com", port: 0 }), "port"],
    ["port 65536", endpointPolicy({ host: "a.example.com", port: 65_536 }), "port"],
    ["no host, no allowed_ips", endpointPolicy({ port: 443 }), "host"],
    ["two-label wildcard", endpointPolicy({ host: "*.com", port: 443 }), "three DNS labels"],
    [
      "access and rules",
      endpointPolicy({ ...REST, access: "full", rules: [{ allow: { method: "GET", path: "/" } }] }),
      "access",
    ],
    ["rest without access or rules", endpointPolicy(REST), "access"],
    ["mcp without rules", endpointPolicy({ ...REST, protocol: "mcp" }), "rules"],
    [
      "access preset on json-rpc",
      endpointPolicy({ ...REST, protocol: "json-rpc", access: "read-only" }),
      "preset",
    ],
    [
      "deny_rules without protocol",
      endpointPolicy({
        host: "a.example.com",
        port: 443,
        deny_rules: [{ method: "GET", path: "/" }],
      }),
      "deny_rules",
    ],
    [
      "deny_rules without rules or access",
      endpointPolicy({ ...REST, deny_rules: [{ method: "GET", path: "/" }] }),
      "deny_rules",
    ],
    [
      "tcp with access",
      endpointPolicy({ host: "db.example.com", port: 5432, protocol: "tcp", access: "full" }),
      "tcp",
    ],
    [
      "tcp with path",
      endpointPolicy({ host: "db.example.com", port: 5432, protocol: "tcp", path: "/x" }),
      "tcp",
    ],
    [
      "tcp without host",
      endpointPolicy({ allowed_ips: ["10.0.0.0/8"], port: 5432, protocol: "tcp" }),
      "tcp",
    ],
    ["tls skip on rest", endpointPolicy({ ...REST, access: "full", tls: "skip" }), "tls"],
    [
      "tls terminate",
      endpointPolicy({ host: "a.example.com", port: 443, tls: "terminate" }),
      "tls",
    ],
    [
      "mcp options on rest",
      endpointPolicy({ ...REST, access: "full", mcp: { strict_tool_names: true } }),
      "mcp",
    ],
    [
      "rest rule without path",
      endpointPolicy({ ...REST, rules: [{ allow: { method: "GET" } }] }),
      "path",
    ],
    [
      "unknown matcher field",
      endpointPolicy({ ...REST, rules: [{ allow: { method: "GET", path: "/", verb: "x" } }] }),
      "verb",
    ],
    [
      "empty mcp versions",
      endpointPolicy({
        ...REST,
        protocol: "mcp",
        mcp: { versions: [], allow_all_known_mcp_methods: true },
      }),
      "versions",
    ],
  ];

  for (const [name, value, needle] of cases) {
    test(name, () => {
      expect(problems(value)).toContain(needle);
    });
  }

  test("overlapping hosts on one port must agree on tls and allowed_ips", () => {
    const policy = {
      version: 1,
      network_policies: {
        a: { endpoints: [{ host: "db.example.com", port: 22, protocol: "tcp", tls: "skip" }] },
        b: { endpoints: [{ host: "*.example.com", port: 22, protocol: "tcp" }] },
      },
    };
    expect(problems(policy)).toContain("same tls");
  });

  test("overlapping inspected endpoints must agree on protocol and enforcement", () => {
    const policy = {
      version: 1,
      network_policies: {
        a: { endpoints: [{ ...REST, access: "read-only" }] },
        b: { endpoints: [{ ...REST, enforcement: "audit", access: "full" }] },
      },
    };
    expect(problems(policy)).toContain("enforcement");
  });

  test("middleware limits: at most 10, unique order, fail_closed never on tls skip", () => {
    const many = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [
        `m${i}`,
        { middleware: "openshell/regex", order: i, endpoints: { include: ["a.example.com"] } },
      ]),
    );
    expect(problems({ version: 1, network_middlewares: many })).toContain("10");
    const dup = {
      a: { middleware: "x", order: 1, endpoints: { include: ["a.example.com"] } },
      b: { middleware: "y", order: 1, endpoints: { include: ["b.example.com"] } },
    };
    expect(problems({ version: 1, network_middlewares: dup })).toContain("order");
    const skip = endpointPolicy(
      { host: "smtp.example.com", port: 25, tls: "skip" },
      {
        network_middlewares: { m: { middleware: "x", endpoints: { include: ["*.example.com"] } } },
      },
    );
    expect(problems(skip)).toContain("tls: skip");
  });

  test("YAML that is not one mapping is rejected", () => {
    expect(parsePolicyYaml("version: 1\n---\nversion: 1\n").ok).toBe(false);
    expect(parsePolicyYaml("version: [\n").ok).toBe(false);
  });
});
