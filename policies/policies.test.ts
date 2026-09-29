import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicies } from "@jevdict/core";
import { parseFixtures, VERDICTS, type Verdict } from "@jevdict/sdk";
import { describeFixtures, fixturePathFor } from "@jevdict/sdk/test";

/**
 * The M0 gate until `jevdict test` exists (spec: "every policy ships with a
 * `*.fixtures.json`; `jevdict test` fails the build on any mismatch"). Every policy is
 * loaded the way the daemon loads it, then each fixture file runs twice: against its own
 * policy alone, and against the whole starter set, so no other policy may change the
 * outcome a fixture pins.
 */

const DIR = import.meta.dir;
const POLICY_FILE = /^[a-z0-9-]+\.ts$/;
const files = readdirSync(DIR)
  .filter((f) => POLICY_FILE.test(f))
  .sort();
const loaded = await loadPolicies(DIR);

function rank(v: Verdict): number {
  return VERDICTS.indexOf(v);
}

function expectedVerdicts(file: string): Set<Verdict> {
  const parsed = parseFixtures(JSON.parse(readFileSync(fixturePathFor(join(DIR, file)), "utf8")));
  if (!parsed.ok) throw new Error(parsed.error.join("\n"));
  return new Set(parsed.value.cases.map((c) => c.expect.verdict));
}

describe("starter policy set", () => {
  test("the loader reports zero problems and loads one policy per file", () => {
    expect(loaded.problems).toEqual([]);
    expect(loaded.policies.map((p) => `${p.name}.ts`).sort()).toEqual(files);
  });

  test("every policy declares a range", () => {
    for (const p of loaded.policies)
      expect({ name: p.name, range: p.range }).toMatchObject({
        name: p.name,
        range: expect.any(Array),
      });
  });

  test("every fixture file covers both ends of its policy's range and a clear allow", () => {
    for (const p of loaded.policies) {
      const [low, high] = p.range ?? ["allow", "kill"];
      const seen = expectedVerdicts(`${p.name}.ts`);
      expect({
        policy: p.name,
        low: seen.has(low),
        high: seen.has(high),
        allow: seen.has("allow"),
      }).toEqual({ policy: p.name, low: true, high: true, allow: true });
      expect(rank(low)).toBeLessThanOrEqual(rank(high));
    }
  });

  test("policies import nothing but @jevdict/sdk", () => {
    for (const file of files) {
      const source = readFileSync(join(DIR, file), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      expect({ file, imports: imports.filter((i) => i !== "@jevdict/sdk") }).toEqual({
        file,
        imports: [],
      });
    }
  });
});

for (const file of files) {
  describeFixtures(join(DIR, file));
  describeFixtures(join(DIR, file), { policies: loaded.policies, label: "with the starter set" });
}
