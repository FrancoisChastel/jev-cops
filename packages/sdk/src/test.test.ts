import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describeFixtures, fixturePathFor } from "./test.ts";

const TESTDATA = join(import.meta.dir, "..", "testdata");

const registered = describeFixtures(join(TESTDATA, "allow-all.ts"));

describe("describeFixtures", () => {
  test("registers one test per fixture case and returns their names", () => {
    expect(registered).toEqual(["a benign edit inside the repo is allowed"]);
  });

  test("the fixture file sits next to the policy module", () => {
    expect(fixturePathFor("/p/off-repo-write.ts")).toBe("/p/off-repo-write.fixtures.json");
    expect(fixturePathFor("/p/x.mjs")).toBe("/p/x.fixtures.json");
  });

  test("a policy without a readable fixture file fails at registration", () => {
    expect(() => describeFixtures(join(TESTDATA, "missing.ts"))).toThrow("cannot read");
  });
});
