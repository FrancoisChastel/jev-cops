import { readFileSync } from "node:fs";

/** One `tool.execute.before` call: the hook's `input` and the `output` whose `args` it may mutate. */
export interface OpenCodeBefore {
  input: { tool: string; sessionID: string; callID: string };
  output: { args: Record<string, unknown> };
}

/** `tool-execute-before.json`: the plugin's `directory` and one call per case name. */
export interface OpenCodeBeforeFixtures {
  directory: string;
  before: Record<string, OpenCodeBefore>;
}

/**
 * Loads the documented `tool.execute.before` calls (see README.md in this directory) as
 * fresh objects: each call reads the file again, so a derived variant never leaks.
 */
export function openCodeBeforeFixtures(): OpenCodeBeforeFixtures {
  const url = new URL("./tool-execute-before.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as OpenCodeBeforeFixtures;
}
