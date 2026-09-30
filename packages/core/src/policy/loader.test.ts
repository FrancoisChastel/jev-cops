import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPolicyHelper, loadPolicies, validatePolicy } from "./loader.ts";

function policySource(name: string, version: number, extra = ""): string {
  return `export default {
  name: ${JSON.stringify(name)},
  version: ${version},
  owner: "cyber-team",
  when: () => true,
  decide: () => "hold",
  reason: "Needs a look.",
  ${extra}
};
`;
}

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jev-cops-loader-"));
  const files: Record<string, string> = {
    "a-alpha.ts": policySource("alpha", 2, 'range: ["annotate", "deny"],'),
    "b-beta.js": policySource("beta", 1),
    "c-bad.ts": `export default { name: "bad", version: 1, owner: "x", when: () => true, reason: "r" };\n`,
    "d-boom.ts": `throw new Error("boom at import");\n`,
    "e-alpha-old.ts": policySource("alpha", 1),
    "f-no-default.ts": "export const x = 1;\n",
    "alpha.test.ts": `throw new Error("test files must never be imported");\n`,
    "alpha.fixtures.json": "[]\n",
    "types.d.ts": "export type X = 1;\n",
    "README.md": "# policies\n",
  };
  await Promise.all(Object.entries(files).map(([f, src]) => writeFile(join(dir, f), src)));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadPolicies", () => {
  test("loads valid modules, reports the rest, keeps the higher duplicate version", async () => {
    // Act
    const { policies, problems } = await loadPolicies(dir);
    // Assert
    expect(policies.map((p) => `${p.name}@${p.version}`)).toEqual(["alpha@2", "beta@1"]);
    expect(problems).toHaveLength(4);
    expect(problems.find((p) => p.startsWith("c-bad.ts"))).toContain("decide must be a function");
    expect(problems.find((p) => p.startsWith("d-boom.ts"))).toContain("boom at import");
    expect(problems.find((p) => p.startsWith("f-no-default.ts"))).toContain("no default export");
    expect(problems).toContain(
      "duplicate policy alpha: alpha@1 (e-alpha-old.ts) ignored, alpha@2 (a-alpha.ts) kept",
    );
  });

  test("skips test files, fixtures, declarations and non-code files", async () => {
    const { problems } = await loadPolicies(dir);
    expect(problems.some((p) => p.includes("alpha.test.ts"))).toBe(false);
    expect(problems.some((p) => p.includes("types.d.ts"))).toBe(false);
  });

  test("a missing directory is a problem, not a throw", async () => {
    const { policies, problems } = await loadPolicies(join(dir, "nope"));
    expect(policies).toEqual([]);
    expect(problems[0]).toContain("cannot read policy directory");
  });

  test("loaded policies are frozen", async () => {
    const { policies } = await loadPolicies(dir);
    expect(policies.every((p) => Object.isFrozen(p))).toBe(true);
  });
});

describe("validatePolicy", () => {
  const valid = {
    name: "exfil-after-secrets",
    version: 3,
    owner: "cyber-team",
    when: () => true,
    decide: () => "deny",
    reason: "r",
  };

  test("accepts a minimal policy and every optional member", () => {
    expect(validatePolicy(valid).ok).toBe(true);
    const full = {
      ...valid,
      ask: () => [],
      detail: () => "d",
      rewrite: () => null,
      contextNote: () => null,
      reason: () => "r",
      range: ["hold", "kill"],
      fallback: "hold",
    };
    expect(validatePolicy(full).ok).toBe(true);
    expect(validatePolicy({ ...valid, range: ["kill", "kill"] }).ok).toBe(true);
  });

  test.each([
    [{ name: "Exfil_After" }, "name must be kebab-case"],
    [{ name: "" }, "name must be kebab-case"],
    [{ version: 0 }, "version must be an integer >= 1"],
    [{ version: 1.5 }, "version must be an integer >= 1"],
    [{ owner: "  " }, "owner must be a non-empty string"],
    [{ when: "yes" }, "when must be a function"],
    [{ when: async () => true }, "when must be synchronous"],
    [{ decide: undefined }, "decide must be a function"],
    [{ ask: [] }, "ask must be a function"],
    [{ reason: "" }, "reason must be a non-empty string or a function"],
    [{ range: ["deny", "hold"] }, "range must ascend the verdict ladder"],
    [{ range: ["hold"] }, "range must be two verdicts"],
    [{ range: ["hold", "block"] }, "range must be two verdicts"],
    [{ fallback: "maybe" }, "fallback must be a verdict"],
    [{ rewrite: "x" }, "rewrite must be a function"],
  ])("rejects %p", (patch, problem) => {
    const result = validatePolicy({ ...valid, ...patch });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(problem);
  });

  test("rejects a non-object", () => {
    expect(validatePolicy(null)).toEqual({ ok: false, error: ["policy must be an object"] });
  });
});

describe("loadPolicies and _-prefixed helpers (policies/_lib/)", () => {
  test("a _lib/ dir and a _shared.ts are helpers: imported by a policy, never loaded as one", async () => {
    // Arrange: a policy importing a helper module from each place, and both helpers
    // shaped so that loading either as a policy would be a problem.
    const own = await mkdtemp(join(tmpdir(), "jev-cops-helpers-"));
    try {
      await mkdir(join(own, "_lib"));
      await writeFile(join(own, "_lib", "trees.ts"), 'export const OWNER = "cyber-team";\n');
      await writeFile(join(own, "_shared.ts"), 'export const REASON = "Needs a look.";\n');
      await writeFile(join(own, "_draft.js"), 'throw new Error("a helper is never imported");\n');
      await writeFile(
        join(own, "delta.ts"),
        `import { OWNER } from "./_lib/trees.ts";
import { REASON } from "./_shared.ts";
export default { name: "delta", version: 1, owner: OWNER, when: () => true,
  decide: () => "hold", reason: REASON };
`,
      );
      // Act
      const { policies, problems } = await loadPolicies(own);
      // Assert
      expect(problems).toEqual([]);
      expect(policies.map((p) => `${p.name}@${p.version}`)).toEqual(["delta@1"]);
      expect(policies[0]?.owner).toBe("cyber-team");
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  test.each([
    ["_lib", true],
    ["_shared.ts", true],
    ["_x.fixtures.json", true],
    ["config-tamper.ts", false],
    ["config-tamper.fixtures.json", false],
    ["lib_helper.ts", false],
  ])("isPolicyHelper(%p) is %p", (entry, helper) => {
    expect(isPolicyHelper(entry)).toBe(helper);
  });
});

describe("loadPolicies with cacheBust (daemon hot reload)", () => {
  test("a changed file is re-imported, an unchanged one is not", async () => {
    const own = await mkdtemp(join(tmpdir(), "jev-cops-reload-"));
    try {
      await writeFile(join(own, "gamma.ts"), policySource("gamma", 1));
      const first = await loadPolicies(own, { cacheBust: true });
      expect(first.policies.map((p) => p.version)).toEqual([1]);
      await writeFile(join(own, "gamma.ts"), policySource("gamma", 22));
      const second = await loadPolicies(own, { cacheBust: true });
      expect(second.problems).toEqual([]);
      expect(second.policies.map((p) => p.version)).toEqual([22]);
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });
});
