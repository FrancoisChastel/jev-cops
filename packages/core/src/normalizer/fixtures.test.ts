import { describe, expect, test } from "bun:test";
import {
  type CommandFixture,
  FIXTURE_CWD,
  FIXTURE_HOME,
  fixtureTitle,
  loadCommandFixtures,
} from "../../../../tests/fixtures/commands/index.ts";
import { loadEventFixture } from "../../../../tests/fixtures/events/index.ts";
import { parseEvent } from "../schema/event.ts";
import { normalizeCommand } from "./command.ts";
import { normalize } from "./normalize.ts";
import type { NormalizedScript, PathAccess } from "./types.ts";

const FIXTURES = loadCommandFixtures();

function sorted(values: ReadonlyArray<string>): string[] {
  return [...values].sort();
}

const ACCESS_RANK: Readonly<Record<PathAccess, number>> = {
  read: 0,
  unknown: 1,
  exec: 2,
  write: 3,
  delete: 4,
};

/** Each path's most severe access, as `e.fs.access` reports it to policies. */
function accessOf(n: NormalizedScript): Record<string, PathAccess> {
  const worst = new Map<string, PathAccess>();
  for (const r of n.commands.flatMap((c) => c.pathRefs)) {
    const prev = worst.get(r.path);
    if (prev === undefined || ACCESS_RANK[r.access] > ACCESS_RANK[prev])
      worst.set(r.path, r.access);
  }
  return Object.fromEntries(worst);
}

/** A bash row through `normalizeCommand`; a tool row as a whole pre event through `normalize`. */
async function normalizeRow(row: CommandFixture): Promise<NormalizedScript> {
  const cwd = row.cwd ?? FIXTURE_CWD;
  if (row.tool === undefined) {
    return normalizeCommand(row.command ?? "", { cwd, home: FIXTURE_HOME });
  }
  const base = loadEventFixture("pre-bash") as Record<string, unknown>;
  const input = row.input ?? { command: row.command };
  const call = { ...(base.call as object), tool: row.tool, kind: row.kind ?? "other", input, cwd };
  const parsed = parseEvent({ ...base, call });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return normalize(parsed.value, { home: FIXTURE_HOME });
}

describe("tests/fixtures/commands/commands.json", () => {
  test("has at least 40 rows", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(40);
  });

  test.each(FIXTURES.map((row) => [fixtureTitle(row), row] as const))("%s", async (_name, row) => {
    // Act
    const n = await normalizeRow(row);

    // Assert
    const { kind, verbs, hosts, paths, opaque, access } = row.expect;
    expect(n.kind).toBe(kind as never);
    if (verbs !== undefined) {
      expect(n.commands.flatMap((c) => c.verbs)).toEqual(expect.arrayContaining(verbs));
    }
    if (hosts !== undefined) expect(sorted(n.hosts)).toEqual(sorted(hosts));
    if (paths !== undefined) expect(sorted(n.paths)).toEqual(sorted(paths));
    if (opaque !== undefined) {
      expect(sorted([...new Set(n.opaque.map((o) => o.reason))])).toEqual(sorted(opaque));
    }
    if (access !== undefined) expect(accessOf(n)).toMatchObject(access);
  });
});
