import { describe, expect, test } from "bun:test";
import { canonicalJson, canonicalPolicy, emitPolicy, inputsHash } from "./emit.ts";
import { type OpenShellPolicy, parsePolicyYaml } from "./schema.ts";

const META = { version: "9.9.9", inputsHash: "ab".repeat(32) };

const POLICY: OpenShellPolicy = {
  network_policies: {
    zeta: {
      binaries: [{ path: "/usr/bin/b" }, { path: "/usr/bin/a" }, { path: "/usr/bin/a" }],
      endpoints: [
        { port: 443, host: "b.example.com", protocol: "rest", access: "read-only" },
        {
          host: "a.example.com",
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { path: "/v1/z", method: "POST" } },
            { allow: { method: "GET", path: "/v1/a/*", query: { z: "1", a: { any: ["x"] } } } },
          ],
        },
      ],
    },
    alpha: { endpoints: [{ host: "git.example.com", port: 22, protocol: "tcp", tls: "skip" }] },
  },
  process: { run_as_group: "1000", run_as_user: "1000" },
  landlock: { compatibility: "hard_requirement" },
  filesystem_policy: {
    read_write: ["/tmp", "/sandbox", "/tmp"],
    read_only: ["/usr", "/etc"],
    include_workdir: false,
  },
  version: 1,
};

describe("emitPolicy", () => {
  test("is deterministic whatever the insertion order", () => {
    const reordered = JSON.parse(JSON.stringify(POLICY, Object.keys(POLICY).reverse()));
    const shuffled: OpenShellPolicy = { ...reordered, ...POLICY };
    expect(emitPolicy(POLICY, META)).toBe(emitPolicy(shuffled, META));
  });

  test("header names the version and the inputs hash", () => {
    const text = emitPolicy(POLICY, META);
    const [first, second, third] = text.split("\n");
    expect(first).toContain("jev-cops 9.9.9");
    expect(second).toContain("schema version 1");
    expect(third).toBe(`# inputs: sha256:${META.inputsHash}`);
  });

  test("documented key order, sorted rule names, quoted strings, bare numbers", () => {
    const text = emitPolicy(POLICY, META);
    const order = [
      "version: 1",
      "filesystem_policy:",
      "landlock:",
      "process:",
      "network_policies:",
    ];
    const at = order.map((line) => text.indexOf(`\n${line}`));
    expect(at.every((i, n) => i > 0 && (n === 0 || i > (at[n - 1] ?? 0)))).toBe(true);
    expect(text.indexOf("  alpha:")).toBeLessThan(text.indexOf("  zeta:"));
    expect(text).toContain('      - host: "a.example.com"\n        port: 443\n');
    expect(text).toContain('          - allow:\n              method: "GET"\n');
    expect(text).toContain(
      '                a:\n                  any:\n                    - "x"\n',
    );
    expect(text).toContain('  read_write:\n    - "/sandbox"\n    - "/tmp"\n');
  });

  test("round-trips through the schema mirror to the canonical policy", () => {
    const parsed = parsePolicyYaml(emitPolicy(POLICY, META));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(canonicalPolicy(POLICY));
  });

  test("backs comments sit above their section or rule", () => {
    const text = emitPolicy(POLICY, {
      ...META,
      backs: { filesystem_policy: ["config-tamper@2"], "network_policies.zeta": ["x@1", "y@2"] },
    });
    expect(text).toContain("# backs: config-tamper@2\nfilesystem_policy:");
    expect(text).toContain("  # backs: x@1, y@2\n  zeta:");
  });

  test("empty lists and maps", () => {
    const text = emitPolicy({ version: 1, filesystem_policy: { read_only: [] } }, META);
    expect(text).toContain("  read_only: []");
    expect(emitPolicy({ version: 1, network_policies: {} }, META)).toContain(
      "network_policies: {}",
    );
  });

  test("keys that are not plain words are quoted", () => {
    const text = emitPolicy(
      {
        version: 1,
        network_policies: {
          r: {
            endpoints: [
              {
                host: "a.example.com",
                port: 443,
                protocol: "rest",
                rules: [{ allow: { method: "GET", path: "/", query: { "a-b c": "1" } } }],
              },
            ],
          },
        },
      },
      META,
    );
    expect(text).toContain('"a-b c": "1"');
  });
});

describe("canonicalPolicy", () => {
  test("sorts and dedupes lists; leaves the input untouched", () => {
    const before = JSON.stringify(POLICY);
    const canon = canonicalPolicy(POLICY);
    expect(canon.filesystem_policy?.read_write).toEqual(["/sandbox", "/tmp"]);
    expect(canon.network_policies?.zeta?.binaries).toEqual([
      { path: "/usr/bin/a" },
      { path: "/usr/bin/b" },
    ]);
    expect(canon.network_policies?.zeta?.endpoints?.[0]?.host).toBe("a.example.com");
    expect(JSON.stringify(POLICY)).toBe(before);
  });
});

describe("inputsHash", () => {
  test("ignores key order, follows values", () => {
    expect(inputsHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      inputsHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(inputsHash({ a: 1 })).not.toBe(inputsHash({ a: 2 }));
    expect(inputsHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: null, a: undefined })).toBe('{"b":null}');
  });
});
