import { readFileSync } from "node:fs";

/** Working directory every row is normalized in, unless the row sets `cwd`. */
export const FIXTURE_CWD = "/work/repo";
/** Home directory `~` and `$HOME` expand to in every row. */
export const FIXTURE_HOME = "/home/dev";

/**
 * What a row asserts about its normalization. Only the keys present are checked: `kind`
 * is the event-level kind; `verbs` must all appear among the commands' verbs; `hosts`,
 * `paths` and `opaque` (the distinct reasons) must match exactly, in any order. An empty
 * list asserts "none". `access` maps listed paths to their most severe access
 * (delete > write > exec > unknown > read, as policies see it in `e.fs.access`).
 */
export interface CommandExpectation {
  kind: string;
  verbs?: string[];
  hosts?: string[];
  paths?: string[];
  opaque?: string[];
  access?: Record<string, string>;
}

/**
 * One row of `commands.json`. Add a row to pin a behaviour; no code needed. A row with
 * only `command` is a bash command (`normalizeCommand`); a row with `tool` is a whole
 * tool call (`normalize`) with `input` (default `{ command }`), the adapter's `kind`
 * (default `other`) and the event's `harness` (default `claude-code`), which decides how
 * the tool name is read (`bash`/`read`/`write`/`edit` differ between Pi and OpenCode).
 */
export interface CommandFixture {
  command?: string;
  tool?: string;
  input?: Record<string, unknown>;
  kind?: string;
  harness?: string;
  cwd?: string;
  expect: CommandExpectation;
}

/** The row's test title: the command, or the harness, the tool and its input. */
export function fixtureTitle(row: CommandFixture): string {
  if (row.tool === undefined) return row.command ?? "";
  const input = JSON.stringify(row.input ?? { command: row.command });
  return `${row.harness === undefined ? "" : `${row.harness}: `}${row.tool} ${input}`;
}

/** Loads the command table as raw JSON; each call returns fresh objects. */
export function loadCommandFixtures(): CommandFixture[] {
  const url = new URL("./commands.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as CommandFixture[];
}
