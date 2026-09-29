import { readFileSync } from "node:fs";

/** Working directory every row is normalized in, unless the row sets `cwd`. */
export const FIXTURE_CWD = "/work/repo";
/** Home directory `~` and `$HOME` expand to in every row. */
export const FIXTURE_HOME = "/home/dev";

/**
 * What a row asserts about `normalizeCommand(command)`. Only the keys present are
 * checked: `kind` is the event-level kind; `verbs` must all appear among the commands'
 * verbs; `hosts`, `paths` and `opaque` (the distinct reasons) must match exactly, in
 * any order. An empty list asserts "none".
 */
export interface CommandExpectation {
  kind: string;
  verbs?: string[];
  hosts?: string[];
  paths?: string[];
  opaque?: string[];
}

/** One row of `commands.json`. Add a row to pin a behaviour; no code needed. */
export interface CommandFixture {
  command: string;
  cwd?: string;
  expect: CommandExpectation;
}

/** Loads the command table as raw JSON; each call returns fresh objects. */
export function loadCommandFixtures(): CommandFixture[] {
  const url = new URL("./commands.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as CommandFixture[];
}
