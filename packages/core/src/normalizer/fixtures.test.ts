import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CWD,
  FIXTURE_HOME,
  loadCommandFixtures,
} from "../../../../tests/fixtures/commands/index.ts";
import { normalizeCommand } from "./command.ts";

const FIXTURES = loadCommandFixtures();

function sorted(values: ReadonlyArray<string>): string[] {
  return [...values].sort();
}

describe("tests/fixtures/commands/commands.json", () => {
  test("has at least 40 rows", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(40);
  });

  test.each(FIXTURES.map((row) => [row.command, row] as const))("%s", async (_name, row) => {
    // Act
    const n = await normalizeCommand(row.command, {
      cwd: row.cwd ?? FIXTURE_CWD,
      home: FIXTURE_HOME,
    });

    // Assert
    const { kind, verbs, hosts, paths, opaque } = row.expect;
    expect(n.kind).toBe(kind as never);
    if (verbs !== undefined) {
      expect(n.commands.flatMap((c) => c.verbs)).toEqual(expect.arrayContaining(verbs));
    }
    if (hosts !== undefined) expect(sorted(n.hosts)).toEqual(sorted(hosts));
    if (paths !== undefined) expect(sorted(n.paths)).toEqual(sorted(paths));
    if (opaque !== undefined) {
      expect(sorted([...new Set(n.opaque.map((o) => o.reason))])).toEqual(sorted(opaque));
    }
  });
});
